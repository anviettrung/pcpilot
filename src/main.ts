// Sidecar PcPilot: remote màn hình từ điện thoại. Giữ kết nối với điện thoại (WebSocket), encode H.264 bằng ffmpeg,
// gửi phím chuột về máy. Phần riêng của từng app (remote màn hình, Unity, app chụp theo cửa sổ) nằm trong src/apps/.
// Nghe ở 127.0.0.1; điện thoại vào qua lớp chuyển tiếp HTTPS (tailscale serve, Cloudflare Tunnel...; xem machines.json > access).
// Chạy quyền thường; phím chuột tới app quyền admin đi qua tiến trình phụ src/elevated.ts.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import index from '../web/index.html';
import { APPS } from './apps';
import type { App, Client, Host, RawFrame, StreamTarget, WS } from './apps/types';
import { isAllowed, isOriginAllowed } from './core/access';
import { ACCESS, cfg, INPUT_PORT, log, machinesCfg, net, PORT, QUALITY, REPO, ROOT, self, UNITY_PORT, type Quality } from './core/config';
import { RawEncoder, ScreenCapture, detectEncoder, findFfmpeg, listOutputs, rawRect, type CaptureOptions, type EncodedFrame, type EncoderKind } from './core/encoder';
import { InputBridge } from './screen/bridge';
import { isMouseAction, isKey } from './screen/input';
import { getOrientation } from './screen/display';
import { isForeground, listMonitors, type Monitor } from './screen/win32';

// --- ffmpeg ------------------------------------------------------------------------------------------
const ffmpeg = findFfmpeg();
if (!ffmpeg) log('không thấy ffmpeg: chưa stream được (cài: winget install Gyan.FFmpeg)');
const forced = process.env.PCPILOT_ENCODER as EncoderKind | undefined; // thử nhánh dự phòng: PCPILOT_ENCODER=libx264
const encoderKind: EncoderKind = forced ?? (ffmpeg ? detectEncoder(ffmpeg) : 'libx264');
let outputs = ffmpeg ? listOutputs(ffmpeg) : [];
let outputsAt = Date.now();
log(`ffmpeg ${ffmpeg ?? '(không có)'}, encoder ${encoderKind}, màn hình ${outputs.map((o) => `#${o.idx} ${o.w}x${o.h}`).join(', ')}`);

const input = new InputBridge(INPUT_PORT);
const clients = new Map<WS, Client>();
const viewers = () => [...clients.values()].filter((c) => c.watch);
let active: App = APPS[0];

// --- Đo đạc theo cửa sổ 1 giây ------------------------------------------------------------------------
const meter = { frames: 0, bytes: 0, capToRecv: 0, recvToEnc: 0, n: 0, fps: 0, kbps: 0, capToRecvMs: 0, recvToEncMs: 0 };
let inputCount = 0;
setInterval(() => {
  meter.fps = meter.frames;
  meter.kbps = Math.round((meter.bytes * 8) / 1000);
  meter.capToRecvMs = meter.n ? +(meter.capToRecv / meter.n).toFixed(1) : 0;
  meter.recvToEncMs = meter.n ? +(meter.recvToEnc / meter.n).toFixed(1) : 0;
  meter.frames = meter.bytes = meter.capToRecv = meter.recvToEnc = meter.n = 0;
  broadcastStatus();
}, 1000);

// --- Cỡ khung ----------------------------------------------------------------------------------------
// Tỉ lệ cạnh dài / cạnh ngắn cho nguồn 'raw' (Unity); 'free' = theo màn hình điện thoại. Dọc hay ngang theo cách cầm.
const ASPECT: Record<string, number> = { '16:9': 16 / 9, iphonex: 2436 / 1125, ipad: 4 / 3 };

/** Người xem vào sau cùng quyết định cỡ khung. */
function rawTarget(): StreamTarget | null {
  const last = viewers().at(-1);
  if (!last) return null;
  const q = QUALITY[last.quality] ?? QUALITY.high;
  const portrait = last.viewH >= last.viewW;
  const ratio = ASPECT[last.aspect] ?? Math.min(2.4, Math.max(1, (portrait ? last.viewH / last.viewW : last.viewW / last.viewH) || 16 / 9));
  const long = Math.round((q.short * ratio) / 2) * 2;
  return { w: portrait ? q.short : long, h: portrait ? long : q.short, fps: last.fps, kbps: q.kbps, quality: last.quality };
}

// --- Nguồn 'raw': khung RGBA từ app (Unity) -------------------------------------------------------------
let rawEnc: RawEncoder | null = null;
let jpegEnc: RawEncoder | null = null;
let lastJpegAt = 0;
let lastError = '';

function ensureRaw(cur: RawEncoder | null, kind: EncoderKind, width: number, height: number, fps: number, kbps: number): RawEncoder {
  const o = { kind, width, height, fps, kbps };
  if (cur?.same(o)) return cur;
  cur?.close();
  log(`ffmpeg ${kind} ${width}x${height} ${fps}fps${kbps ? ` ${kbps}kbps` : ''}`);
  const e: RawEncoder = new RawEncoder({ ffmpeg: ffmpeg!, ...o }, (fr) => onEncoded(fr, kind === 'mjpeg'), (msg) => {
    if (!e.closed) {
      lastError = msg;
      log(msg);
    }
  });
  for (const c of viewers()) if (c.jpeg === (kind === 'mjpeg')) c.needKey = true;
  return e;
}

function pushRaw(f: RawFrame) {
  const all = viewers();
  if (!ffmpeg || !all.length) return;
  const t = rawTarget()!;
  const meta = { frameId: f.frameId, captureMs: f.captureMs, inputSeq: f.inputSeq, width: f.width, height: f.height, receivedMs: Date.now() };
  if (all.some((c) => !c.jpeg)) {
    rawEnc = ensureRaw(rawEnc, encoderKind, f.width, f.height, t.fps, t.kbps);
    rawEnc.push(f.rgba, meta);
  }
  // Trình duyệt không có WebCodecs: ảnh JPEG, tối đa 15 khung/giây cho nhẹ mạng.
  if (all.some((c) => c.jpeg) && meta.receivedMs - lastJpegAt >= 1000 / 15 - 5) {
    lastJpegAt = meta.receivedMs;
    jpegEnc = ensureRaw(jpegEnc, 'mjpeg', f.width, f.height, 15, 0);
    jpegEnc.push(f.rgba, meta);
  }
}

// --- Nguồn 'screen': chụp vùng màn hình app chỉ ra ---------------------------------------------------------
let capture: ScreenCapture | null = null;
/** Vùng đang chụp theo toạ độ màn hình ảo: phím chuột từ điện thoại đổi toạ độ theo vùng này. */
let area: { x: number; y: number; w: number; h: number; hwnd?: bigint; cls?: string } | null = null;
let reason = '';
let retryAt = 0;

// Màn hình (toạ độ màn hình ảo) → chỉ số output DXGI của ddagrab: khớp theo cỡ; nhiều màn hình cùng cỡ thì theo thứ
// tự màn hình chính trước, rồi từ trái sang phải (thứ tự DXGI thường đi như vậy).
function outputFor(m: Monitor): number | null {
  const mons = listMonitors();
  // Số màn hình đổi, hay màn hình vừa xoay / đổi độ phân giải (không output nào cùng cỡ): hỏi lại ddagrab.
  const stale = outputs.length !== mons.length || !outputs.some((o) => o.w === m.w && o.h === m.h);
  if (ffmpeg && stale && Date.now() - outputsAt > (outputs.length !== mons.length ? 30_000 : 2_000)) {
    outputs = listOutputs(ffmpeg);
    outputsAt = Date.now();
    log(`màn hình đổi: ${outputs.map((o) => `#${o.idx} ${o.w}x${o.h}`).join(', ')}`);
  }
  const same = outputs.filter((o) => o.w === m.w && o.h === m.h);
  const i = mons.filter((x) => x.w === m.w && x.h === m.h).findIndex((x) => x.x === m.x && x.y === m.y);
  return (same[Math.max(0, i)] ?? same[0])?.idx ?? null;
}

function closeCapture() {
  capture?.close();
  capture = null;
  area = null;
}

function updateCapture() {
  const r = active.region!();
  if (typeof r === 'string') {
    if (capture) log('dừng chụp:', r);
    reason = r;
    return closeCapture();
  }
  const m = r.monitor;
  const idx = outputFor(m);
  if (idx === null) return (reason = 'monitor'), closeCapture();
  // Phần nằm ngoài màn hình thì cắt bớt; số chẵn cho yuv420p.
  const left = r.x - m.x, top = r.y - m.y;
  const x = Math.max(0, left), y = Math.max(0, top);
  const w = (Math.min(left + r.w, m.w) - x) & ~1, h = (Math.min(top + r.h, m.h) - y) & ~1;
  if (w < 64 || h < 64) return (reason = 'offscreen'), closeCapture();
  reason = '';
  const last = viewers().at(-1)!;
  const q = QUALITY[last.quality] ?? QUALITY.high;
  const short = Math.min(w, h);
  const k = Math.min(q.short, short) / short; // không phóng to quá cỡ gốc
  // Màn hình đang xoay: ddagrab cắt trong khung gốc (chưa xoay), ffmpeg xoay lại (xem rawRect).
  const rotation = getOrientation(m.device) ?? 0;
  const raw = rawRect({ x, y, w, h }, m.w, m.h, rotation);
  const opt: CaptureOptions = {
    ffmpeg: ffmpeg!, kind: encoderKind === 'mjpeg' ? 'libx264' : encoderKind, outputIdx: idx, ...raw,
    outW: Math.max(2, Math.round((w * k) / 2) * 2), outH: Math.max(2, Math.round((h * k) / 2) * 2),
    fps: last.fps, kbps: q.kbps, cursor: r.cursor !== false, rotation,
  };
  area = { x: m.x + x, y: m.y + y, w, h, hwnd: r.hwnd, cls: r.cls };
  if (capture && capture.alive && capture.same(opt)) return;
  if (capture && !capture.alive && Date.now() < retryAt) return;
  capture?.close();
  log(`chụp ${active.name}: màn hình #${idx} vùng ${x},${y} ${w}x${h}${rotation ? ` (xoay ${rotation})` : ''} → ${opt.outW}x${opt.outH} ${opt.fps}fps ${opt.kind}`);
  lastError = '';
  retryAt = Date.now() + 5000; // ffmpeg hỏng ngay (vd màn hình khoá) thì 5 giây sau mới thử lại
  const c: ScreenCapture = new ScreenCapture(opt, (f) => onEncoded(f, false), (msg) => {
    if (!c.closed) {
      lastError = msg;
      log(msg);
    }
  });
  capture = c;
  for (const cl of viewers()) cl.needKey = true;
}

/** Chọn nguồn hình theo app đang xem và người xem: chỉ app đang xem được chụp, không ai xem thì tắt hết. */
function refresh() {
  const want = viewers().length > 0 && !!ffmpeg;
  for (const a of APPS) if (a.source === 'raw') a.stream!(want && a === active ? rawTarget() : null);
  if (!want || active.source !== 'raw') {
    rawEnc?.close();
    jpegEnc?.close();
    rawEnc = jpegEnc = null;
  }
  if (want && active.source === 'screen') updateCapture();
  else {
    if (capture) log('dừng chụp', want ? '' : '(không còn ai xem)');
    closeCapture();
    reason = '';
  }
}
// Cửa sổ dời chỗ, đổi cỡ, thu nhỏ: kiểm mỗi giây rồi chụp lại cho khớp.
setInterval(() => active.source === 'screen' && viewers().length && refresh(), 1000);

function activate(id: string) {
  const a = APPS.find((x) => x.id === id);
  if (!a || a === active) return;
  log(`chuyển sang ${a.name}`);
  active = a;
  for (const c of clients.values()) {
    c.needKey = true;
    releaseAll(c);
  }
  refresh();
  broadcastStatus();
}

// --- Gửi khung -----------------------------------------------------------------------------------------
// Số chạm toàn cục: mỗi client tự đếm từ 1 (tải lại trang là đếm lại), nhiều client thì trùng nhau.
// Bắt đầu theo giờ để sidecar khởi động lại vẫn lớn hơn số Unity còn nhớ.
let globalSeq = Date.now() % 1_000_000_000;
function inputSeq(c: Client, clientSeq: number): number {
  const g = ++globalSeq;
  c.seqMap.push([g, clientSeq]);
  if (c.seqMap.length > 300) c.seqMap.shift();
  return g;
}
function clientSeq(c: Client, seq: number): number {
  for (let i = c.seqMap.length - 1; i >= 0; i--) if (c.seqMap[i][0] <= seq) return c.seqMap[i][1];
  return 0;
}

function onEncoded(f: EncodedFrame, jpeg: boolean) {
  if (!jpeg) {
    meter.frames++;
    meter.bytes += f.data.length;
    meter.capToRecv += f.receivedMs - f.captureMs;
    meter.recvToEnc += f.encodedMs - f.receivedMs;
    meter.n++;
  }
  // Gói gửi điện thoại: 32 byte đầu + Annex B (loại 1) hoặc JPEG (loại 2).
  const msg = new Uint8Array(32 + f.data.length);
  const dv = new DataView(msg.buffer);
  dv.setUint8(0, jpeg ? 2 : 1);
  dv.setUint8(1, f.key ? 1 : 0);
  dv.setUint16(2, f.width, true);
  dv.setUint16(4, f.height, true);
  dv.setUint32(8, f.frameId, true);
  dv.setFloat64(16, f.captureMs, true);
  dv.setFloat64(24, Date.now(), true);
  msg.set(f.data, 32);
  const n = viewers().length;
  for (const [ws, c] of clients) {
    if (!c.watch || c.jpeg !== jpeg) continue;
    if (c.needKey && !f.key) continue;
    // Mạng chậm: đừng dồn hàng, bỏ tới keyframe kế tiếp.
    if (ws.getBufferedAmount() > 512 * 1024) {
      c.needKey = true;
      continue;
    }
    c.needKey = false;
    dv.setInt32(12, f.inputSeq ? clientSeq(c, f.inputSeq) : 0, true);
    ws.send(n > 1 ? msg.slice() : msg);
  }
}

// --- Phím, chuột (app 'screen') -------------------------------------------------------------------------
const lastPos = new WeakMap<Client, [number, number]>();
const UP: Record<string, string> = { down: 'up', rdown: 'rup', mdown: 'mup' };

/** Nhả mọi phím và nút chuột client còn giữ: mất kết nối giữa chừng thì không để kẹt trên PC. */
function releaseAll(c: Client | undefined) {
  if (!c) return;
  for (const k of c.held) input.key(k, false);
  if (c.held.size) log(`nhả các phím còn giữ: ${[...c.held].join(', ')}`);
  c.held.clear();
  const p = lastPos.get(c);
  for (const b of c.buttons) if (p) input.mouse(p[0], p[1], UP[b] as any);
  c.buttons.clear();
}
for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const)
  process.on(sig, () => {
    for (const c of clients.values()) releaseAll(c);
    for (const a of APPS) {
      try {
        a.shutdown?.();
      } catch {}
    }
    if (sig !== 'exit') process.exit(0);
  });

const foreground = () => !area?.hwnd || isForeground(area.hwnd, area.cls);
const refuse = (ws: WS, why: string) => ws.send(JSON.stringify({ type: 'inputResult', ok: false, reason: why }));

function onInput(ws: WS, c: Client, m: any) {
  if (active.source !== 'screen' || !area) return;
  // Game có luật an toàn: cửa sổ không ở trên cùng thì không gửi, kẻo gõ nhầm vào ứng dụng khác.
  const blocked = active.requireForeground && !foreground();
  switch (m.type) {
    case 'key': {
      const code = String(m.k);
      if (!isKey(code)) return;
      if (m.down) {
        if (blocked) return refuse(ws, 'notForeground');
        if (c.held.has(code)) return;
        c.held.add(code);
      } else {
        if (!c.held.delete(code)) return;
      }
      input.key(code, !!m.down);
      inputCount++;
      return;
    }
    case 'text': {
      const s = String(m.s ?? '').slice(0, 500);
      if (!s) return;
      if (blocked) return refuse(ws, 'notForeground');
      input.text(s);
      inputCount++;
      return;
    }
    case 'mouse': {
      const a = String(m.a);
      if (!isMouseAction(a)) return;
      const isUp = a === 'up' || a === 'rup' || a === 'mup';
      const downOf = a.replace('up', 'down'); // up → down, rup → rdown, mup → mdown
      if (isUp && !c.buttons.has(downOf)) return;
      if (!isUp && blocked) return a === 'move' ? undefined : refuse(ws, 'notForeground');
      const clamp = (v: number) => Math.min(1, Math.max(0, Number(v) || 0));
      const x = area.x + Math.round(clamp(m.x) * (area.w - 1));
      const y = area.y + Math.round(clamp(m.y) * (area.h - 1));
      lastPos.set(c, [x, y]);
      if (a in UP) c.buttons.add(a);
      if (isUp) c.buttons.delete(downOf);
      input.mouse(x, y, a, Number(m.d) || 0);
      if (a !== 'move') inputCount++;
      return;
    }
    case 'focus': {
      if (!area.hwnd) return;
      const hwnd = area.hwnd;
      void input.focus(hwnd).then((ok) => {
        log(`đưa ${active.name} lên trên: ${ok ? 'được' : 'không được'}`);
        if (!ok) refuse(ws, 'focusFailed');
        broadcastStatus();
      });
      return;
    }
  }
}

// --- Phiên bản, tự cập nhật -------------------------------------------------------------------------
// Phiên bản = giờ commit cuối của kho (so được giữa các máy). Trang thấy máy nào cũ hơn thì cho bấm Cập
// nhật: sidecar kéo kho pcpilot rồi tự thoát, scripts/run-sidecar.ps1 chạy lại sau 5 giây với mã mới. Nhờ vậy không cần
// ngồi trước máy kia (hay mở Claude Code ở đó) mới cập nhật được.
const BUILD = String(Date.now()); // đổi mỗi lần sidecar khởi động: trang thấy khác thì mời tải lại
function git(...args: string[]) {
  const r = Bun.spawnSync(['git', '-C', REPO, ...args], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
}
const versionOf = (rev: string) => Number(git('log', '-1', '--format=%ct', rev).out) || 0;
const VERSION = versionOf('HEAD');
/** Mã tiến trình gửi phím quyền admin dùng: đổi thì nhờ nó tự thoát để chạy lại bằng mã mới. */
const ELEVATED_PATHS = ['src/elevated.ts', 'src/screen', 'src/core/config.ts', 'src/core/access.ts', 'shared'];
let updating = false;

async function selfUpdate(ws: WS) {
  if (updating) return;
  updating = true;
  try {
    const before = git('rev-parse', 'HEAD').out;
    // fetch + merge --ff-only (kho có thay đổi chưa commit hay lệch nhánh thì dừng, không ép).
    const f = git('fetch', '--quiet', 'origin');
    const mg = f.ok ? git('merge', '--ff-only', '--quiet', '@{u}') : f;
    if (!mg.ok) return notice(ws, `Không kéo được kho pcpilot trên máy ${self.name}: ${mg.out.slice(0, 200)}`, true);
    const after = git('rev-parse', 'HEAD').out;
    if (versionOf('HEAD') === VERSION) return notice(ws, `Máy ${self.name} đã chạy bản mới nhất`);
    if (before !== after && !git('diff', '--quiet', before, after, '--', 'bun.lock').ok)
      Bun.spawnSync([process.execPath, 'install'], { cwd: ROOT, stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    if (before !== after && !git('diff', '--quiet', before, after, '--', ...ELEVATED_PATHS).ok) input.quit();
    // Ghi phiên bản đang chạy để install.ps1 lần sau khỏi khởi động lại thêm lần nữa.
    const tree = git('rev-parse', 'HEAD:');
    if (tree.ok) {
      mkdirSync(join(homedir(), '.pcpilot'), { recursive: true });
      writeFileSync(join(homedir(), '.pcpilot', 'pcpilot-tree.txt'), tree.out + '\n');
    }
    log(`tự cập nhật ${before.slice(0, 7)} -> ${after.slice(0, 7)}, khởi động lại`);
    notice(ws, `Máy ${self.name} đã kéo bản mới, đang khởi động lại (khoảng 10 giây)`);
    setTimeout(() => process.exit(0), 500);
  } finally {
    updating = false;
  }
}

// --- Trạng thái ----------------------------------------------------------------------------------------
function statusEvent() {
  const enc = active.source === 'screen' ? capture : rawEnc;
  return {
    type: 'status',
    build: BUILD,
    version: VERSION,
    machine: self.name,
    machines: machinesCfg.machines.map((m) => ({ name: m.name, host: m.host, url: machineUrl(m) })),
    httpsPort: cfg.httpsPort,
    tailnet: net.tailnet,
    app: active.id,
    apps: Object.fromEntries(APPS.map((a) => [a.id, { name: a.name, source: a.source, ...a.status() }])),
    stream: {
      ffmpeg: !!ffmpeg,
      encoder: encoderKind,
      capturing: active.source === 'screen' ? !!capture?.alive : !!rawEnc?.alive,
      reason,
      error: lastError,
      target: capture ? { w: capture.opt.outW, h: capture.opt.outH } : rawEnc ? { w: rawEnc.opt.width, h: rawEnc.opt.height } : null,
      fps: meter.fps,
      kbps: meter.kbps,
      capToRecvMs: meter.capToRecvMs,
      recvToEncMs: meter.recvToEncMs,
      splitErrors: enc?.splitErrors ?? 0,
      dropped: enc?.dropped ?? 0,
      viewers: viewers().length,
      jpegViewers: viewers().filter((c) => c.jpeg).length,
      inputs: inputCount,
      /** Cửa sổ đang chụp có ở trên cùng không (chụp cả màn hình thì luôn true). */
      foreground: foreground(),
      window: !!area?.hwnd,
      requireForeground: !!active.requireForeground,
      elevated: input.elevated,
    },
  };
}

function broadcast(obj: object) {
  const s = JSON.stringify(obj);
  for (const ws of clients.keys()) ws.send(s);
}
const broadcastStatus = () => broadcast(statusEvent());

function notice(ws: WS, text: string, error = false) {
  ws.send(JSON.stringify({ type: 'notice', machine: self.name, text, error }));
}

const host: Host = {
  log,
  notice,
  broadcast,
  broadcastStatus,
  isActive: (id) => active.id === id,
  activate,
  refresh,
  pushRaw,
  inputSeq,
  clients,
  input,
};
for (const a of APPS) a.init(host);

// --- Bảo mật (giống ClaudeMon) ----------------------------------------------------------------------
// Địa chỉ HTTPS của sidecar từng máy: `url` trong machines.json, hoặc https://<host>.<tailnet>:<httpsPort> khi dùng Tailscale.
function machineUrl(m: { host?: string; url?: string }): string | undefined {
  if (ACCESS === 'local') return undefined;
  if (m.url) return m.url.replace(/\/+$/, '');
  if (ACCESS === 'tailscale' && net.tailnet && m.host) return `https://${m.host}.${net.tailnet}:${cfg.httpsPort}`;
  return undefined;
}
// Chỉ nhận request từ chính máy này, hoặc qua lớp chuyển tiếp (access.mode) từ đúng tài khoản chủ. Xem src/core/access.ts.
const allowed = (req: Request) => isAllowed(req, machinesCfg.owner, machinesCfg.access);
const originAllowed = (req: Request) => isOriginAllowed(req, machinesCfg.machines.map(machineUrl));

const forbidden = () => new Response('forbidden', { status: 403 });
const guard = (h: (req: Request) => Response | Promise<Response>) => async (req: Request) => ((await allowed(req)) ? h(req) : forbidden());

function staticFile(name: string, type?: string) {
  const path = resolve(ROOT, 'web', 'public', name);
  return guard(() => new Response(Bun.file(path), { headers: { ...(type ? { 'content-type': type } : {}), 'cache-control': 'no-cache' } }));
}

// Kết quả đo (chế độ ?autotest) và ảnh chụp: ghi ra tệp cạnh mã, đã gitignore.
const RESULTS = resolve(ROOT, 'spike-results.jsonl');
const SHOTS = resolve(ROOT, 'shots');

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  idleTimeout: 0,
  development: process.env.PCPILOT_DEV === '1',
  routes: {
    '/': index,
    '/manifest.webmanifest': staticFile('manifest.webmanifest', 'application/manifest+json'),
    '/icon-192.png': staticFile('icon-192.png'),
    '/icon-512.png': staticFile('icon-512.png'),
    '/icon-maskable-512.png': staticFile('icon-maskable-512.png'),
    '/apple-touch-icon.png': staticFile('apple-touch-icon.png'),
    '/apps/unity.png': staticFile('apps/unity.png'),
    '/sw.js': staticFile('sw.js', 'text/javascript'),
    '/api/status': guard(() => Response.json(statusEvent())),
  },
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (!(await allowed(req)) || !originAllowed(req)) return forbidden();
      if (srv.upgrade(req, { data: { ua: req.headers.get('user-agent') ?? '' } } as any)) return;
      return new Response('upgrade failed', { status: 400 });
    }
    return new Response('not found', { status: 404 });
  },
  websocket: {
    maxPayloadLength: 16 << 20,
    open(ws) {
      clients.set(ws, {
        watch: false, needKey: true, viewW: 390, viewH: 844, quality: 'high', fps: 30, jpeg: false, aspect: 'free', app: '',
        held: new Set(), buttons: new Set(), seqMap: [], mobile: { on: false, rotate: 'auto', scale: 0 },
      });
      ws.send(JSON.stringify(statusEvent()));
      for (const a of APPS) a.onOpen?.(ws);
    },
    message(ws, raw) {
      const c = clients.get(ws);
      if (!c || typeof raw !== 'string') return;
      let m: any;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      switch (m.type) {
        case 'hello':
        case 'view': {
          const wasWatching = c.watch;
          c.viewW = Number(m.w) || c.viewW;
          c.viewH = Number(m.h) || c.viewH;
          if (m.quality in QUALITY) c.quality = m.quality as Quality;
          if (m.fps === 30 || m.fps === 60) c.fps = m.fps;
          if (typeof m.jpeg === 'boolean') c.jpeg = m.jpeg;
          if (m.aspect === 'free' || m.aspect in ASPECT) c.aspect = m.aspect;
          if (typeof m.watch === 'boolean') c.watch = m.watch;
          if (m.mobile && typeof m.mobile === 'object')
            c.mobile = {
              on: !!m.mobile.on,
              rotate: ['auto', 'portrait', 'off'].includes(m.mobile.rotate) ? m.mobile.rotate : 'auto',
              scale: Math.max(0, Math.min(500, Number(m.mobile.scale) || 0)),
            };
          if (wasWatching && !c.watch) releaseAll(c);
          // Đưa client này xuống cuối để nó quyết định cỡ khung (và app, nếu nó vừa vào xem).
          clients.delete(ws);
          clients.set(ws, c);
          c.needKey = true;
          if (c.watch && m.type === 'hello' && typeof m.app === 'string') activate(m.app);
          refresh();
          break;
        }
        case 'app':
          if (c.watch) activate(String(m.id));
          break;
        case 'key':
        case 'text':
        case 'mouse':
        case 'focus':
          if (c.watch) onInput(ws, c, m);
          break;
        case 'update':
          void selfUpdate(ws);
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', t0: m.t0, ts: Date.now() }));
          break;
        case 'report':
          appendFileSync(RESULTS, JSON.stringify({ at: new Date().toISOString(), ua: (ws.data as any)?.ua, ...m.data, server: statusEvent() }) + '\n');
          log('đã ghi kết quả đo', m.data?.label ?? '');
          break;
        case 'snapshot':
          if (typeof m.png === 'string' && m.png.startsWith('data:image/png;base64,')) {
            mkdirSync(SHOTS, { recursive: true });
            const name = `${String(m.name ?? 'shot').replace(/[^\w-]/g, '')}-${Date.now()}.png`;
            writeFileSync(resolve(SHOTS, name), Buffer.from(m.png.slice(22), 'base64'));
            log('đã lưu ảnh', name);
          }
          break;
        default:
          for (const a of APPS) if (a.onMessage?.(ws, c, m)) break;
      }
    },
    close(ws) {
      const c = clients.get(ws);
      releaseAll(c);
      clients.delete(ws);
      if (!c?.watch) return;
      // Chờ một chút: điện thoại tải lại trang hay đổi mạng thì khỏi dừng rồi chạy lại.
      setTimeout(() => !viewers().length && refresh(), 3000);
    },
  },
});

log(`pcpilot ${self.name} tại http://${server.hostname}:${server.port}, Unity nối vào 127.0.0.1:${UNITY_PORT}, tiến trình gửi phím 127.0.0.1:${INPUT_PORT}`);
