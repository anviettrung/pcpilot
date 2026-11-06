// Sidecar UnityPilot: chơi thử game Unity trong Editor từ điện thoại. Giữ kết nối với điện thoại (WebSocket), encode
// H.264 bằng ffmpeg từ khung RGBA app đưa sang. Phần riêng của từng app (hiện có Unity) nằm trong src/apps/.
// Nghe ở 127.0.0.1; máy khác vào qua `tailscale serve` (cổng HTTPS riêng, xem install.ps1). Chạy quyền thường.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import index from '../web/index.html';
import { APPS } from './apps';
import type { App, Client, Host, RawFrame, StreamTarget, WS } from './apps/types';
import { cfg, log, machinesCfg, net, PORT, QUALITY, REPO, ROOT, self, UNITY_PORT, type Quality } from './core/config';
import { RawEncoder, detectEncoder, findFfmpeg, type EncodedFrame, type EncoderKind } from './core/encoder';

// --- ffmpeg ------------------------------------------------------------------------------------------
const ffmpeg = findFfmpeg();
if (!ffmpeg) log('không thấy ffmpeg: chưa stream được (cài: winget install Gyan.FFmpeg)');
const forced = process.env.UNITYPILOT_ENCODER as EncoderKind | undefined; // thử nhánh dự phòng: UNITYPILOT_ENCODER=libx264
const encoderKind: EncoderKind = forced ?? (ffmpeg ? detectEncoder(ffmpeg) : 'libx264');
log(`ffmpeg ${ffmpeg ?? '(không có)'}, encoder ${encoderKind}`);

const clients = new Map<WS, Client>();
const viewers = () => [...clients.values()].filter((c) => c.watch);
let active: App = APPS[0];

// --- Đo đạc theo cửa sổ 1 giây ------------------------------------------------------------------------
const meter = { frames: 0, bytes: 0, capToRecv: 0, recvToEnc: 0, n: 0, fps: 0, kbps: 0, capToRecvMs: 0, recvToEncMs: 0 };
setInterval(() => {
  meter.fps = meter.frames;
  meter.kbps = Math.round((meter.bytes * 8) / 1000);
  meter.capToRecvMs = meter.n ? +(meter.capToRecv / meter.n).toFixed(1) : 0;
  meter.recvToEncMs = meter.n ? +(meter.recvToEnc / meter.n).toFixed(1) : 0;
  meter.frames = meter.bytes = meter.capToRecv = meter.recvToEnc = meter.n = 0;
  broadcastStatus();
}, 1000);

// --- Cỡ khung ----------------------------------------------------------------------------------------
// Tỉ lệ cạnh dài / cạnh ngắn (Game view Unity đổi theo); 'free' = theo màn hình điện thoại. Dọc hay ngang theo cách cầm.
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

// --- Nguồn hình: khung RGBA từ app (Unity) --------------------------------------------------------------
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

function closeEncoders() {
  rawEnc?.close();
  jpegEnc?.close();
  rawEnc = jpegEnc = null;
}

/** Bật nguồn hình theo app đang xem và người xem: chỉ app đang xem được bật, không ai xem thì tắt hết. */
function refresh() {
  const want = viewers().length > 0 && !!ffmpeg;
  for (const a of APPS) a.stream(want && a === active ? rawTarget() : null);
  if (!want) {
    if (rawEnc || jpegEnc) log('dừng encode (không còn ai xem)');
    closeEncoders();
  }
}

function activate(id: string) {
  const a = APPS.find((x) => x.id === id);
  if (!a || a === active) return;
  log(`chuyển sang ${a.name}`);
  active = a;
  for (const c of clients.values()) c.needKey = true;
  closeEncoders(); // khung của app mới có thể khác cỡ: encoder mở lại theo khung đầu tiên
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

for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const)
  process.on(sig, () => {
    for (const a of APPS) {
      try {
        a.shutdown?.();
      } catch {}
    }
    if (sig !== 'exit') process.exit(0);
  });

// --- Phiên bản, tự cập nhật -------------------------------------------------------------------------
// Phiên bản = giờ commit cuối của kho (so được giữa các máy). Trang thấy máy nào cũ hơn thì cho bấm Cập
// nhật: sidecar kéo kho unitypilot rồi tự thoát, scripts/run-sidecar.ps1 chạy lại sau 5 giây với mã mới. Nhờ vậy không cần
// ngồi trước máy kia (hay mở Claude Code ở đó) mới cập nhật được.
const BUILD = String(Date.now()); // đổi mỗi lần sidecar khởi động: trang thấy khác thì mời tải lại
function git(...args: string[]) {
  const r = Bun.spawnSync(['git', '-C', REPO, ...args], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
}
const versionOf = (rev: string) => Number(git('log', '-1', '--format=%ct', rev).out) || 0;
const VERSION = versionOf('HEAD');
let updating = false;

async function selfUpdate(ws: WS) {
  if (updating) return;
  updating = true;
  try {
    const before = git('rev-parse', 'HEAD').out;
    // fetch + merge --ff-only (kho có thay đổi chưa commit hay lệch nhánh thì dừng, không ép).
    const f = git('fetch', '--quiet', 'origin');
    const mg = f.ok ? git('merge', '--ff-only', '--quiet', '@{u}') : f;
    if (!mg.ok) return notice(ws, `Không kéo được kho unitypilot trên máy ${self.name}: ${mg.out.slice(0, 200)}`, true);
    const after = git('rev-parse', 'HEAD').out;
    if (versionOf('HEAD') === VERSION) return notice(ws, `Máy ${self.name} đã chạy bản mới nhất`);
    if (before !== after && !git('diff', '--quiet', before, after, '--', 'bun.lock').ok)
      Bun.spawnSync([process.execPath, 'install'], { cwd: ROOT, stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    // Ghi phiên bản đang chạy để install.ps1 lần sau khỏi khởi động lại thêm lần nữa.
    const tree = git('rev-parse', 'HEAD:');
    if (tree.ok) {
      mkdirSync(join(homedir(), '.unitypilot'), { recursive: true });
      writeFileSync(join(homedir(), '.unitypilot', 'unitypilot-tree.txt'), tree.out + '\n');
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
  return {
    type: 'status',
    build: BUILD,
    version: VERSION,
    machine: self.name,
    machines: machinesCfg.machines.map((m) => ({ name: m.name, host: m.host })),
    httpsPort: cfg.httpsPort,
    tailnet: net.tailnet,
    app: active.id,
    apps: Object.fromEntries(APPS.map((a) => [a.id, { name: a.name, ...a.status() }])),
    stream: {
      ffmpeg: !!ffmpeg,
      encoder: encoderKind,
      capturing: !!rawEnc?.alive,
      error: lastError,
      target: rawEnc ? { w: rawEnc.opt.width, h: rawEnc.opt.height } : null,
      fps: meter.fps,
      kbps: meter.kbps,
      capToRecvMs: meter.capToRecvMs,
      recvToEncMs: meter.recvToEncMs,
      splitErrors: rawEnc?.splitErrors ?? 0,
      dropped: rawEnc?.dropped ?? 0,
      viewers: viewers().length,
      jpegViewers: viewers().filter((c) => c.jpeg).length,
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
};
for (const a of APPS) a.init(host);

// --- Bảo mật (giống ClaudeMon) ----------------------------------------------------------------------
// Chỉ nhận request từ chính máy này, hoặc qua `tailscale serve` từ đúng tài khoản chủ.
function allowed(req: Request): boolean {
  const login = req.headers.get('tailscale-user-login');
  return login === null || login.toLowerCase() === machinesCfg.owner.toLowerCase();
}

function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    const label = u.hostname.split('.')[0];
    return u.protocol === 'https:' && u.hostname.endsWith('.ts.net') && machinesCfg.machines.some((m) => m.host === label);
  } catch {
    return false;
  }
}

const forbidden = () => new Response('forbidden', { status: 403 });
const guard = (h: (req: Request) => Response | Promise<Response>) => (req: Request) => (allowed(req) ? h(req) : forbidden());

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
  development: process.env.UNITYPILOT_DEV === '1',
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
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (!allowed(req) || !originAllowed(req)) return forbidden();
      if (srv.upgrade(req, { data: { ua: req.headers.get('user-agent') ?? '' } } as any)) return;
      return new Response('upgrade failed', { status: 400 });
    }
    return new Response('not found', { status: 404 });
  },
  websocket: {
    maxPayloadLength: 16 << 20,
    open(ws) {
      clients.set(ws, { watch: false, needKey: true, viewW: 390, viewH: 844, quality: 'high', fps: 30, jpeg: false, aspect: 'free', seqMap: [] });
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
          c.viewW = Number(m.w) || c.viewW;
          c.viewH = Number(m.h) || c.viewH;
          if (m.quality in QUALITY) c.quality = m.quality as Quality;
          if (m.fps === 30 || m.fps === 60) c.fps = m.fps;
          if (typeof m.jpeg === 'boolean') c.jpeg = m.jpeg;
          if (m.aspect === 'free' || m.aspect in ASPECT) c.aspect = m.aspect;
          if (typeof m.watch === 'boolean') c.watch = m.watch;
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
      clients.delete(ws);
      if (!c?.watch) return;
      // Chờ một chút: điện thoại tải lại trang hay đổi mạng thì khỏi dừng rồi chạy lại.
      setTimeout(() => !viewers().length && refresh(), 3000);
    },
  },
});

log(`unitypilot ${self.name} tại http://${server.hostname}:${server.port}, Unity nối vào 127.0.0.1:${UNITY_PORT}`);
