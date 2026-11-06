// Encode H.264 độ trễ thấp bằng ffmpeg (h264_nvenc nếu có card NVIDIA, không thì libx264). Hai nguồn hình:
// - RawEncoder: nhận khung RGBA thô qua stdin (Unity tự chụp Game view rồi gửi sang).
// - ScreenCapture: ffmpeg tự chụp một vùng màn hình bằng Desktop Duplication (ddagrab), ở mức màn hình như OBS
//   "Display Capture": không đụng tới tiến trình hay cửa sổ nào. Cửa sổ khác đè lên vùng chụp thì hình cũng thấy.
// Đầu ra Annex B có AUD (NAL 9) mở đầu mỗi khung; cắt thành từng khung theo AUD, cộng một mốc "rảnh" 2 ms để khỏi
// phải chờ AUD của khung sau (đỡ trễ thêm một khung).
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type EncoderKind = 'h264_nvenc' | 'libx264' | 'mjpeg';

export interface FrameMeta {
  frameId: number;
  /** Lúc chụp (giờ máy chủ, ms). Chụp màn hình bằng ffmpeg thì không biết, lấy lúc ffmpeg nhả khung. */
  captureMs: number;
  /** Số chạm cuối cùng nguồn hình đã thấy trước khi chụp khung này (0 = không biết). */
  inputSeq: number;
  width: number;
  height: number;
  receivedMs: number;
}

export interface EncodedFrame extends FrameMeta {
  key: boolean;
  data: Uint8Array;
  encodedMs: number;
}

export function findFfmpeg(): string | null {
  const w = Bun.which('ffmpeg');
  if (w) return w;
  const local = process.env.LOCALAPPDATA ?? '';
  const link = join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
  if (existsSync(link)) return link;
  const pk = join(local, 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const d of readdirSync(pk).filter((n) => n.startsWith('Gyan.FFmpeg'))) {
      for (const sub of readdirSync(join(pk, d))) {
        const exe = join(pk, d, sub, 'bin', 'ffmpeg.exe');
        if (existsSync(exe)) return exe;
      }
    }
  } catch {}
  return null;
}

export function detectEncoder(ffmpeg: string): EncoderKind {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.1',
    '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { timeout: 15000 });
  return r.status === 0 ? 'h264_nvenc' : 'libx264';
}

/** Kích thước từng màn hình theo thứ tự output của DXGI (chỉ số ddagrab dùng). */
export function listOutputs(ffmpeg: string): { idx: number; w: number; h: number }[] {
  const out: { idx: number; w: number; h: number }[] = [];
  for (let idx = 0; idx < 6; idx++) {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'verbose', '-filter_complex', `ddagrab=output_idx=${idx}`,
      '-frames:v', '1', '-f', 'null', '-'], { timeout: 15000 });
    const m = /Opened dxgi output \d+ with dimensions (\d+)x(\d+)/.exec(String(r.stderr));
    if (!m) break;
    out.push({ idx, w: Number(m[1]), h: Number(m[2]) });
  }
  return out;
}

/** Tham số encode H.264: baseline, không B-frame, keyframe mỗi ~1 giây (điện thoại vào giữa chừng có hình ngay). */
function h264Args(kind: EncoderKind, fps: number, kbps: number): string[] {
  const gop = String(Math.max(1, Math.round(fps)));
  const rate = kbps <= 0 ? [] : ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${Math.round(kbps / 2)}k`];
  if (kind === 'mjpeg') return ['-c:v', 'mjpeg', '-q:v', '6', '-pix_fmt', 'yuvj420p'];
  if (kind === 'h264_nvenc')
    return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-delay', '0', '-rc', 'cbr',
      '-profile:v', 'baseline', '-bf', '0', '-g', gop, '-forced-idr', '1', '-aud', '1', ...rate];
  // Đừng tắt sliced-threads: tắt thì x264 chuyển sang frame-threading, trễ lên ~540 ms.
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p',
    '-x264-params', `aud=1:keyint=${gop}:min-keyint=${gop}:scenecut=0`, ...rate];
}

/** Một tiến trình ffmpeg ra Annex B (hoặc JPEG), cắt thành từng khung. */
abstract class FfmpegStream {
  protected proc: ChildProcessWithoutNullStreams;
  private buf: Uint8Array = new Uint8Array(0);
  private idle: Timer | null = null;
  private dead = false;
  /** close() đã được gọi (thoát do mình đóng, không phải lỗi). */
  closed = false;
  /** Số lần một khung tới làm nhiều mẩu cách nhau quá mốc rảnh (khung bị cắt sai). */
  splitErrors = 0;
  dropped = 0;

  constructor(ffmpeg: string, args: string[], private jpeg: boolean, onExit: (msg: string) => void) {
    this.proc = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    this.proc.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    this.proc.stdout.on('data', (d: Buffer) => (this.jpeg ? this.onJpeg(d) : this.onData(d)));
    this.proc.stdin.on('error', () => {});
    this.proc.on('exit', (code) => {
      this.dead = true;
      onExit(`ffmpeg thoát (mã ${code}) ${err.trim()}`);
    });
  }

  get alive() {
    return !this.dead;
  }

  close() {
    this.closed = true;
    if (this.idle) clearTimeout(this.idle);
    this.dead = true;
    try {
      this.proc.stdin.end();
      this.proc.kill();
    } catch {}
  }

  /** Một khung đã cắt xong (Annex B trọn một access unit, hoặc một ảnh JPEG). */
  protected abstract emit(data: Uint8Array, key: boolean): void;

  private onData(d: Buffer) {
    if (this.idle) {
      clearTimeout(this.idle);
      this.idle = null;
    }
    let chunk: Uint8Array = d;
    if (this.buf.length === 0 && findAud(chunk, 0) !== 0) {
      // Mẩu sau của khung đã gửi đi vì tưởng xong: bỏ, khung sau sẽ có hình lại (decoder tự hồi ở keyframe).
      this.splitErrors++;
      const i = findAud(chunk, 0);
      if (i < 0) return;
      chunk = chunk.subarray(i);
    }
    this.buf = concat(this.buf, chunk);
    // Mỗi AUD từ vị trí 1 trở đi mở đầu khung mới: phần trước nó là một khung trọn vẹn.
    let cut = findAud(this.buf, 1);
    while (cut > 0) {
      const au = this.buf.subarray(0, cut);
      this.emit(au.slice(), hasIdr(au));
      this.buf = this.buf.subarray(cut);
      cut = findAud(this.buf, 1);
    }
    if (this.buf.length) this.idle = setTimeout(() => this.flushIdle(), 2);
  }

  // JPEG: mỗi ảnh kết thúc bằng FF D9 (trong dữ liệu nén, FF luôn đi kèm 00 nên không nhầm).
  private onJpeg(d: Buffer) {
    const from = this.buf.length;
    this.buf = concat(this.buf, d);
    for (let i = Math.max(1, from - 1); i < this.buf.length; i++) {
      if (this.buf[i - 1] === 0xff && this.buf[i] === 0xd9) {
        this.emit(this.buf.slice(0, i + 1), true);
        this.buf = this.buf.subarray(i + 1);
        i = 0;
      }
    }
  }

  private flushIdle() {
    this.idle = null;
    if (!this.buf.length) return;
    const au = this.buf.slice();
    this.buf = new Uint8Array(0);
    this.emit(au, hasIdr(au));
  }
}

// --- Khung RGBA thô (Unity) ---------------------------------------------------------------------
export interface RawEncoderOptions {
  ffmpeg: string;
  kind: EncoderKind;
  width: number;
  height: number;
  fps: number;
  kbps: number;
}

export class RawEncoder extends FfmpegStream {
  private metas: FrameMeta[] = [];

  constructor(readonly opt: RawEncoderOptions, private onFrame: (f: EncodedFrame) => void, onExit: (msg: string) => void) {
    super(
      opt.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${opt.width}x${opt.height}`,
        '-framerate', String(opt.fps), '-i', '-', ...h264Args(opt.kind, opt.fps, opt.kbps), '-fps_mode', 'passthrough',
        '-flush_packets', '1', '-f', opt.kind === 'mjpeg' ? 'image2pipe' : 'h264', '-'],
      opt.kind === 'mjpeg',
      onExit,
    );
  }

  same(o: Omit<RawEncoderOptions, 'ffmpeg'>) {
    return this.alive && o.kind === this.opt.kind && o.width === this.opt.width && o.height === this.opt.height && o.fps === this.opt.fps && o.kbps === this.opt.kbps;
  }

  /** Đưa một khung RGBA vào; ffmpeg còn bận khung trước thì bỏ khung này. */
  push(rgba: Uint8Array, meta: FrameMeta): boolean {
    if (!this.alive) return false;
    if (this.proc.stdin.writableLength > rgba.length) {
      this.dropped++;
      return false;
    }
    this.metas.push(meta);
    this.proc.stdin.write(rgba);
    return true;
  }

  protected emit(data: Uint8Array, key: boolean) {
    const meta = this.metas.shift();
    if (!meta) return;
    this.onFrame({ ...meta, key, data, encodedMs: Date.now() });
  }
}

// --- Chụp vùng màn hình (ddagrab) -----------------------------------------------------------------
export interface CaptureOptions {
  ffmpeg: string;
  kind: EncoderKind;
  outputIdx: number;
  /** Vùng chụp, toạ độ trong màn hình đó (pixel thật). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Cỡ khung gửi đi. */
  outW: number;
  outH: number;
  fps: number;
  kbps: number;
  /** Vẽ con trỏ chuột vào hình. */
  cursor: boolean;
  /**
   * Màn hình đang xoay (0 ngang, 1 dọc, 2 ngang lật, 3 dọc lật). Desktop Duplication trả khung theo chiều quét gốc
   * của màn hình (không xoay), nên x, y, w, h là toạ độ trong khung gốc đó và ffmpeg xoay lại trước khi thu nhỏ.
   */
  rotation: number;
}

/** Vùng (toạ độ trong màn hình đang xoay, cỡ mw × mh) → vùng trong khung gốc ddagrab trả về. */
export function rawRect(r: { x: number; y: number; w: number; h: number }, mw: number, mh: number, rotation: number) {
  if (rotation === 1) return { x: r.y, y: mw - (r.x + r.w), w: r.h, h: r.w };
  if (rotation === 3) return { x: mh - (r.y + r.h), y: r.x, w: r.h, h: r.w };
  if (rotation === 2) return { x: mw - (r.x + r.w), y: mh - (r.y + r.h), w: r.w, h: r.h };
  return { ...r };
}

export class ScreenCapture extends FfmpegStream {
  private nextId = 1;

  constructor(readonly opt: CaptureOptions, private onFrame: (f: EncodedFrame) => void, onExit: (msg: string) => void) {
    const src = `ddagrab=output_idx=${opt.outputIdx}:framerate=${opt.fps}:draw_mouse=${opt.cursor ? 1 : 0}` +
      `:offset_x=${opt.x}:offset_y=${opt.y}:video_size=${opt.w}x${opt.h}`;
    const turn = ['', ',transpose=clock', ',hflip,vflip', ',transpose=cclock'][opt.rotation] ?? '';
    const [rw, rh] = opt.rotation % 2 ? [opt.h, opt.w] : [opt.w, opt.h]; // cỡ sau khi xoay lại
    const scale = opt.outW === rw && opt.outH === rh ? '' : `,scale=${opt.outW}:${opt.outH}:flags=bilinear`;
    const graph = `${src},hwdownload,format=bgra${turn}${scale},format=yuv420p`;
    super(
      opt.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-filter_complex', graph, ...h264Args(opt.kind, opt.fps, opt.kbps),
        '-fps_mode', 'passthrough', '-flush_packets', '1', '-f', 'h264', '-'],
      false,
      onExit,
    );
  }

  same(o: CaptureOptions) {
    return (Object.keys(o) as (keyof CaptureOptions)[]).every((k) => o[k] === this.opt[k]);
  }

  protected emit(data: Uint8Array, key: boolean) {
    const t = Date.now();
    this.onFrame({
      frameId: this.nextId++, captureMs: t, inputSeq: 0, width: this.opt.outW, height: this.opt.outH, receivedMs: t,
      key, data, encodedMs: t,
    });
  }
}

// --- Annex B ---------------------------------------------------------------------------------------
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const r = new Uint8Array(a.length + b.length);
  r.set(a);
  r.set(b, a.length);
  return r;
}

// Tìm start code 00 00 01 hoặc 00 00 00 01 có NAL loại 9 (AUD), trả vị trí đầu start code.
function findAud(b: Uint8Array, from: number): number {
  for (let i = from; i + 3 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3] & 0x1f) === 9) {
      const pos = i > 0 && b[i - 1] === 0 ? i - 1 : i;
      if (pos >= from) return pos;
    }
  }
  return -1;
}

function hasIdr(b: Uint8Array): boolean {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3] & 0x1f) === 5) return true;
  }
  return false;
}
