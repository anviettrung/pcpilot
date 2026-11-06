// PWA PcPilot: nhận H.264 qua WebSocket, giải mã bằng WebCodecs, vẽ lên canvas; thao tác gửi về theo app đang xem
// (chuột, bàn phím, bàn phím ảo cho remote màn hình và game; chạm ảo, Play/Stop cho Unity).
import { WEB_APPS } from './apps';
import {
  $, S, actions, applyZoom, canvas, esc, isOpen, links, median, now, params, pct, prefs, r1, resolveInput,
  sample, samples, savePrefs, send, sendTo, sortedLinks, stage, status, toast, useJpeg, zoom, type Link, type MachineInfo, type Overlay, type WebApp,
} from './core';

const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })!;
const overlay = $('overlay');
const stat = $('stat');
const sheet = $('sheet');
const backdrop = $('backdrop');

const appOf = (id: string | undefined): WebApp => WEB_APPS.find((a) => a.id === id) ?? WEB_APPS[0];
const current = () => appOf(status()?.app);

// --- WebSocket ------------------------------------------------------------------------------------
const homeUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const isLocalPage = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const sameOrigin = (u?: string) => {
  try {
    return !!u && new URL(u).origin === location.origin;
  } catch {
    return false;
  }
};
/** Máy đang phục vụ trang (theo url khai báo, hoặc tên máy trong tailnet). */
const pageMachine = (list?: MachineInfo[]) =>
  list?.find((m) => sameOrigin(m.url)) ??
  (location.hostname.endsWith('.ts.net') ? list?.find((m) => m.host === location.hostname.split('.')[0]) : undefined);

function machineUrl(m: MachineInfo): string {
  if (isLocalPage && m.name === prefs.home) return homeUrl;
  if (sameOrigin(m.url)) return homeUrl;
  // Sidecar báo sẵn địa chỉ HTTPS của từng máy (url khai báo, hoặc địa chỉ tailnet).
  if (m.url) return m.url.replace(/^http/, 'ws') + '/ws';
  // Bản sidecar cũ không gửi url: tự ghép địa chỉ tailnet.
  const suffix = isLocalPage ? prefs.tailnet : location.hostname.endsWith('.ts.net') ? location.hostname.split('.').slice(1).join('.') : '';
  if (!suffix || !m.host) return '';
  return `wss://${m.host}.${suffix}:${prefs.httpsPort ?? 8443}/ws`;
}

function ensureLink(url: string, name = ''): Link {
  let l = links.find((x) => x.url === url);
  if (l) {
    l.name ||= name;
    return l;
  }
  l = { url, name, ws: null, open: false, status: null, retry: 500, data: {} };
  links.push(l);
  connect(l);
  return l;
}

function connect(l: Link) {
  const ws = new WebSocket(l.url);
  l.ws = ws;
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    l.open = true;
    l.retry = 500;
    sendView('hello', l);
    render();
  };
  ws.onclose = () => {
    if (l.ws !== ws) return;
    l.open = false;
    l.ws = null;
    for (const a of WEB_APPS) a.onJson?.(l, { type: 'closed' });
    render();
    setTimeout(() => connect(l), l.retry);
    l.retry = Math.min(l === S.view ? 5000 : 15000, l.retry * 2);
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') onJson(l, JSON.parse(e.data));
    else if (l === S.view) onVideo(e.data as ArrayBuffer);
  };
}

function appWanted(l: Link): { app?: string } {
  const id = params.get('app') ?? (l.name ? prefs.apps?.[l.name] : undefined);
  return id ? { app: id } : {};
}

function sendView(type = 'view', l: Link = S.view) {
  const r = stage.getBoundingClientRect();
  sendTo(l, {
    type,
    watch: l === S.view,
    w: Math.round(r.width),
    h: Math.round(r.height),
    quality: prefs.quality,
    fps: prefs.fps,
    aspect: prefs.aspect,
    mobile: prefs.mobile,
    jpeg: useJpeg,
    // Vào xem máy này: xin lại app đã xem lần trước trên máy đó.
    // ?app=<id> trên địa chỉ trang thì xin app đó (script thử dùng).
    ...(type === 'hello' && l === S.view ? appWanted(l) : {}),
  });
}

/** Đổi sang xem máy khác. */
function switchView(l: Link) {
  if (l === S.view) return;
  const old = S.view;
  current().releaseAll?.();
  S.view = l;
  if (l.name) prefs.view = l.name;
  savePrefs();
  sendView('view', old); // máy cũ: thôi xem, sidecar dừng stream
  resetVideo();
  sendView('hello', l);
  render();
}

function resetVideo() {
  decoder?.close();
  decoder = null;
  decW = decH = 0;
  waitKey = true;
  pendingMeta.clear();
  S.lastFrameAt = 0;
  bestRtt = Infinity;
  clockOffset = 0;
  for (const k of Object.keys(samples) as (keyof typeof samples)[]) samples[k] = [];
  ctx.fillStyle = '#0d0f12';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

let viewChosen = false;
setTimeout(() => (viewChosen = true), 5000);
function rememberMachines(l: Link, m: any) {
  l.name = m.machine ?? l.name;
  let changed = false;
  if (l.url === homeUrl && prefs.home !== l.name) [prefs.home, changed] = [l.name, true];
  if (Array.isArray(m.machines) && JSON.stringify(m.machines) !== JSON.stringify(prefs.machines)) [prefs.machines, changed] = [m.machines, true];
  if (m.tailnet && m.tailnet !== prefs.tailnet) [prefs.tailnet, changed] = [m.tailnet, true];
  if (m.httpsPort && m.httpsPort !== prefs.httpsPort) [prefs.httpsPort, changed] = [m.httpsPort, true];
  if (changed) savePrefs();
  for (const mc of prefs.machines ?? []) {
    const url = machineUrl(mc);
    if (url) ensureLink(url, mc.name);
  }
  // Mở trang lần đầu: quay lại máy đã xem lần trước.
  if (!viewChosen && prefs.view && l.name === prefs.view && l !== S.view) switchView(l);
}

// Phiên bản sidecar lúc trang mở; sidecar khởi động lại (thường là vừa cập nhật) thì mời tải lại trang.
let firstBuild = '';
let clockOffset = 0; // giờ máy chủ - giờ máy này
let bestRtt = Infinity;
let lastApp = '';
const REASON: Record<string, string> = {
  notForeground: 'Cửa sổ không ở trên cùng trên PC: chưa gửi',
  focusFailed: 'Không đưa được cửa sổ lên trên',
};

function onJson(l: Link, m: any) {
  for (const a of WEB_APPS) if (a.onJson?.(l, m)) return;
  if (m.type === 'status') {
    l.status = m;
    rememberMachines(l, m);
    if (l.url === homeUrl && m.build) {
      firstBuild ||= m.build;
      if (m.build !== firstBuild) $('updateBanner').hidden = false;
    }
    if (l === S.view) {
      if (m.app !== lastApp) {
        if (lastApp) appOf(lastApp).enter?.(false);
        lastApp = m.app;
        zoom.k = 1;
        applyZoom();
        appOf(m.app).enter?.(true);
      }
      render();
    }
  } else if (m.type === 'notice') {
    toast(`${m.machine}: ${m.text}`, m.error);
  } else if (m.type === 'inputResult') {
    if (!m.ok) toast(REASON[m.reason] ?? 'Lỗi gửi thao tác', true);
  } else if (m.type === 'pong') {
    if (l !== S.view) return;
    const t1 = now();
    const rtt = t1 - m.t0;
    sample('rtt', rtt);
    // Ước lượng lệch giờ từ lần ping có RTT nhỏ nhất (gần đối xứng nhất).
    if (rtt <= bestRtt * 1.2 || samples.rtt.length < 3) {
      bestRtt = Math.min(bestRtt, rtt);
      clockOffset = m.ts - (m.t0 + t1) / 2;
    }
  }
}
setInterval(() => send({ type: 'ping', t0: now() }), 1000);

// --- Video ----------------------------------------------------------------------------------------
let decoder: VideoDecoder | null = null;
let decW = 0, decH = 0, codec = '';
let waitKey = true;
let frameCount = 0, keyCount = 0, bytes = 0;
const pendingMeta = new Map<number, { captureMs: number; inputSeq: number; decodeStart: number }>();

function codecFromSps(au: Uint8Array): string | null {
  for (let i = 0; i + 6 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3] & 0x1f) === 7) {
      const h = (b: number) => b.toString(16).padStart(2, '0');
      return `avc1.${h(au[i + 4])}${h(au[i + 5])}${h(au[i + 6])}`;
    }
  }
  return null;
}

function sized(w: number, h: number) {
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w;
  canvas.height = h;
  fit();
}

function drew(meta: { captureMs: number; inputSeq: number; decodeStart: number } | undefined) {
  S.drawn++;
  const t = now();
  if (!meta) return;
  sample('decode', t - meta.decodeStart);
  sample('video', t + clockOffset - meta.captureMs);
  resolveInput(meta.inputSeq, t);
}

function makeDecoder(c: string, w: number, h: number) {
  decoder?.close();
  decoder = new VideoDecoder({
    output: (frame) => {
      const meta = pendingMeta.get(frame.timestamp);
      pendingMeta.delete(frame.timestamp);
      sized(frame.displayWidth, frame.displayHeight);
      ctx.drawImage(frame, 0, 0);
      frame.close();
      drew(meta);
    },
    error: (e) => {
      console.warn('decoder', e);
      decoder = null;
      waitKey = true;
    },
  });
  decoder.configure({ codec: c, codedWidth: w, codedHeight: h, optimizeForLatency: true });
  codec = c;
  decW = w;
  decH = h;
}

function onVideo(buf: ArrayBuffer) {
  const dv = new DataView(buf);
  const kind = dv.getUint8(0);
  if (kind !== 1 && kind !== 2) return;
  const key = dv.getUint8(1) === 1;
  const w = dv.getUint16(2, true), h = dv.getUint16(4, true);
  const frameId = dv.getUint32(8, true);
  const inputSeq = dv.getInt32(12, true);
  const captureMs = dv.getFloat64(16, true);
  const sentMs = dv.getFloat64(24, true);
  const au = new Uint8Array(buf, 32);
  const recv = now();
  S.lastFrameAt = recv;
  frameCount++;
  bytes += buf.byteLength;
  if (key) keyCount++;
  sample('net', recv + clockOffset - sentMs);
  if (kind === 2) return void drawJpeg(au, { captureMs, inputSeq, decodeStart: recv });
  if (useJpeg) return;

  if (!decoder || decoder.state === 'closed' || w !== decW || h !== decH) {
    if (!key) return;
    const c = codecFromSps(au);
    if (!c) return;
    makeDecoder(c, w, h);
    waitKey = false;
  }
  if (waitKey && !key) return;
  // Giải mã không kịp: bỏ tới keyframe kế tiếp thay vì để trễ dồn lên.
  if (decoder!.decodeQueueSize > 4 && !key) {
    waitKey = true;
    return;
  }
  waitKey = false;
  const ts = frameId * 1000;
  pendingMeta.set(ts, { captureMs, inputSeq, decodeStart: recv });
  if (pendingMeta.size > 60) pendingMeta.delete(pendingMeta.keys().next().value!);
  decoder!.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data: au }));
}

let jpegBusy = false;
async function drawJpeg(data: Uint8Array, meta: { captureMs: number; inputSeq: number; decodeStart: number }) {
  if (jpegBusy) return; // còn đang vẽ ảnh trước: bỏ ảnh này
  jpegBusy = true;
  try {
    const bmp = await createImageBitmap(new Blob([data as BlobPart], { type: 'image/jpeg' }));
    sized(bmp.width, bmp.height);
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    codec = 'jpeg';
    drew(meta);
  } catch {
  } finally {
    jpegBusy = false;
  }
}

function fit() {
  const r = stage.getBoundingClientRect();
  if (!canvas.width || !canvas.height) return;
  const k = Math.min(r.width / canvas.width, r.height / canvas.height);
  canvas.style.width = `${Math.floor(canvas.width * k)}px`;
  canvas.style.height = `${Math.floor(canvas.height * k)}px`;
  applyZoom();
}

let viewTimer = 0;
function resized() {
  fit();
  clearTimeout(viewTimer);
  viewTimer = window.setTimeout(() => sendView(), 300);
}
addEventListener('resize', resized);

// --- Chạm lên hình: giao cho app đang xem ----------------------------------------------------------
const touchesLayer = $('touches');
const showTouches = $<HTMLInputElement>('showTouches');
showTouches.checked = prefs.showTouches !== false;
showTouches.onchange = () => {
  prefs.showTouches = showTouches.checked;
  savePrefs();
};
// Vòng tròn ở chỗ ngón tay: thấy ngay chạm đã gửi, so với lúc hình phản hồi là cảm được độ trễ.
const touchDots = new Map<number, HTMLElement>();
function showTouch(e: PointerEvent, ph: string) {
  if (!showTouches.checked) return;
  const r = stage.getBoundingClientRect();
  let el = touchDots.get(e.pointerId);
  if (!el && ph === 'down') {
    el = document.createElement('div');
    el.className = 'touch';
    touchesLayer.append(el);
    touchDots.set(e.pointerId, el);
  }
  if (!el) return;
  el.style.left = `${e.clientX - r.left}px`;
  el.style.top = `${e.clientY - r.top}px`;
  if (ph === 'up' || ph === 'cancel') {
    touchDots.delete(e.pointerId);
    el.classList.add('up');
    setTimeout(() => el!.remove(), 300);
  }
}
for (const [ev, ph] of [['pointerdown', 'down'], ['pointermove', 'move'], ['pointerup', 'up'], ['pointercancel', 'cancel']] as const)
  canvas.addEventListener(ev, (e) => {
    if (ph === 'down') {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {}
      e.preventDefault();
    }
    current().pointer?.(e, ph);
    showTouch(e, ph);
  });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
// Rời trang hay ẩn app: nhả hết, không để phím kẹt trên PC.
const releaseAll = () => current().releaseAll?.();
document.addEventListener('visibilitychange', () => document.visibilityState !== 'visible' && releaseAll());
addEventListener('blur', releaseAll);
addEventListener('pagehide', releaseAll);

// --- Bảng cài đặt, thanh dưới ----------------------------------------------------------------------
function openSheet(open: boolean) {
  sheet.hidden = backdrop.hidden = !open;
  if (open) render();
}
$('menuBtn').onclick = () => openSheet(true);
$('info').onclick = () => openSheet(true);
$('reloadBtn').onclick = () => location.reload();
$('updateBanner').onclick = () => location.reload();
$('closeSheet').onclick = () => openSheet(false);
$('overlayPick').onclick = () => openSheet(true);
backdrop.onclick = () => openSheet(false);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('dialog').hidden) $('dialog').click();
  else openSheet(false);
});

const isStandalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || (navigator as any).standalone;
const fullBtn = $<HTMLButtonElement>('fullBtn');
fullBtn.hidden = !document.fullscreenEnabled;
$('installHint').hidden = !!document.fullscreenEnabled || !!isStandalone;
fullBtn.onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
  openSheet(false);
};

// Thu gọn thanh: hình chiếm cả màn hình, còn một nút nổi nhỏ ở góc.
function setCompact(on: boolean) {
  prefs.compact = on;
  savePrefs();
  document.body.classList.toggle('compact', on);
  $('miniBtn').hidden = !on;
  resized();
}
$('hideBarBtn').onclick = () => setCompact(true);

// Nút nổi kéo được (đè lên UI thì dời đi chỗ khác), chạm nhẹ thì hiện lại thanh. Vị trí lưu theo tỉ lệ màn hình.
const mini = $('miniBtn');
function placeMini() {
  const p = prefs.miniPos;
  if (!p) return;
  mini.style.left = `${Math.round(p[0] * (innerWidth - 34))}px`;
  mini.style.top = `${Math.round(p[1] * (innerHeight - 34))}px`;
}
let drag: { x: number; y: number; moved: boolean } | null = null;
mini.addEventListener('pointerdown', (e) => {
  mini.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, moved: false };
});
mini.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
  drag.moved = true;
  prefs.miniPos = [
    Math.min(1, Math.max(0, (e.clientX - 17) / (innerWidth - 34))),
    Math.min(1, Math.max(0, (e.clientY - 17) / (innerHeight - 34))),
  ];
  placeMini();
});
mini.addEventListener('pointerup', () => {
  if (drag?.moved) savePrefs();
  else setCompact(false);
  drag = null;
});
addEventListener('resize', placeMini);
placeMini();
setCompact(!!prefs.compact);

function bindSeg(id: string, get: () => string, set: (v: string) => void) {
  const box = $(id);
  const paint = () => box.querySelectorAll<HTMLElement>('[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === get()));
  box.querySelectorAll<HTMLElement>('[data-v]').forEach(
    (b) =>
      (b.onclick = () => {
        set(b.dataset.v!);
        savePrefs();
        paint();
        sendView();
      }),
  );
  paint();
}
bindSeg('aspectSeg', () => prefs.aspect, (v) => (prefs.aspect = v));
bindSeg('qualitySeg', () => prefs.quality, (v) => (prefs.quality = v));
bindSeg('fpsSeg', () => String(prefs.fps), (v) => (prefs.fps = Number(v)));

// Giữ màn hình sáng khi đang dùng.
let wakeLock: any = null;
let wakeBusy = false;
async function keepAwake(on: boolean) {
  const wl = (navigator as any).wakeLock;
  if (!wl || wakeBusy) return;
  wakeBusy = true;
  try {
    if (on && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await wl.request('screen').catch(() => null);
      wakeLock?.addEventListener?.('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  } finally {
    wakeBusy = false;
  }
}

const quality = (ms: number) => (!Number.isFinite(ms) ? '' : ms <= 80 ? 'q-good' : ms <= 160 ? 'q-ok' : 'q-bad');

// --- Vẽ trạng thái ---------------------------------------------------------------------------------
function render() {
  const st = status();
  const app = current();
  const a = st?.apps?.[app.id] ?? {};
  const machine = st?.machine ?? S.view?.name ?? '';
  const hasFrames = now() - S.lastFrameAt < 2000;

  let o: Overlay | null = null;
  if (!isOpen()) o = { title: 'Mất kết nối', text: `Đang nối lại máy ${S.view?.name || machine}…`, spin: true, pick: links.length > 1 ? 'Chọn máy khác' : '' };
  else if (!st) o = { title: 'Đang kết nối…', spin: true };
  else if (!st.stream?.ffmpeg) o = { title: 'Thiếu ffmpeg', text: `Máy ${machine} chưa cài ffmpeg (winget install Gyan.FFmpeg).` };
  else if (useJpeg && app.id !== 'unity') o = { title: 'Trình duyệt không hỗ trợ', text: 'Cần WebCodecs (Chrome, Safari iOS 16.4+).' };
  else {
    o = app.overlay?.(st, a) ?? null;
    if (!o && !hasFrames) o = { title: 'Đang chờ hình…', text: st.stream?.error ?? '', spin: true };
  }
  overlay.hidden = !o;
  $('overlayTitle').textContent = o?.title ?? '';
  $('overlayText').textContent = o?.text ?? '';
  $('spinner').hidden = !o?.spin;
  $('overlayPlay').hidden = !o?.play;
  $('overlayPick').hidden = !o?.pick;
  const act = $<HTMLButtonElement>('overlayAct');
  act.hidden = !o?.action;
  act.textContent = o?.action?.label ?? '';
  act.classList.toggle('secondary', !!o?.action?.secondary);
  act.onclick = o?.action ? o.action.run : null;
  $('overlayPick').textContent = o?.pick || 'Chọn';

  for (const g of document.querySelectorAll<HTMLElement>('#bar [data-group]')) g.hidden = g.dataset.group !== app.group;
  app.render?.(st, a);

  const live = isOpen() && !!st && (app.live ? app.live(st, a) : true) && hasFrames;
  keepAwake(live);
  const v = median(samples.video), inp = median(samples.input);
  const lat = samples.input.length ? inp : v;
  const q = live ? quality(lat) : '';
  for (const id of ['dot', 'miniDot']) $(id).className = q;
  stat.innerHTML = st ? `<b>${esc(machine)}</b> · ${esc(app.label?.(a) ?? a.name ?? '')}${useJpeg ? ' · JPEG' : ''}` : '…';
  $('lat').textContent = live && Number.isFinite(lat) ? `${Math.round(lat)} ms` : '';

  if (sheet.hidden) return;
  for (const s of document.querySelectorAll<HTMLElement>('#sheet [data-section]')) s.hidden = s.dataset.section !== app.section;
  renderMachineSeg();
  renderAppSeg(st);
  app.sheet?.(st, a);
  const info: string[] = [];
  if (st?.stream && !st.stream.elevated && app.group === 'screen')
    info.push('Chưa có tiến trình gửi phím quyền admin: app chạy quyền admin sẽ không nhận phím, chuột (chạy install.ps1 quyền admin một lần để cài).');
  const more = app.info?.(a);
  $('appInfo').innerHTML =
    `<b>${esc(machine)} · ${esc(app.label?.(a) ?? a.name ?? '')}</b>${more ? ` · ${esc(more)}` : ''}` +
    info.map((x) => `<br><span class="warn">${esc(x)}</span>`).join('');
  if (st?.stream && $<HTMLDetailsElement>('metricsBox').open) {
    const s = st.stream;
    const rows: [string, string][] = [
      ...(samples.input.length ? ([['Chạm → hiện', `${r1(inp)} ms (${samples.input.length} mẫu)`]] as [string, string][]) : []),
      [app.id === 'unity' ? 'Chụp → hiện' : 'Encode → hiện', `${r1(v)} ms · p90 ${r1(pct(samples.video, 0.9))}`],
      ['Mạng · RTT', `${r1(median(samples.net))} · ${r1(median(samples.rtt))} ms`],
      ['Giải mã', `${r1(median(samples.decode))} ms`],
      ...(app.metrics?.(st) ?? []),
      ['Encoder', useJpeg ? 'JPEG' : s.encoder],
      ['Khung', s.target ? `${s.target.w}×${s.target.h}` : '–'],
      ['Luồng', `${s.fps} fps · ${(s.kbps / 1000).toFixed(1)} Mbps`],
      ['Bỏ khung', `${s.dropped} · cắt sai ${s.splitErrors}`],
      ['Gửi phím', s.elevated ? 'quyền admin' : 'quyền thường'],
    ];
    $('metrics').innerHTML = rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('');
  }
}
setInterval(render, 500);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && render());

// Hàng chọn máy: đổi qua lại giữa các máy ngay trong trang, link nào cũng vậy.
const newestVersion = () => Math.max(0, ...links.map((l) => Number(l.status?.version) || 0));
function renderMachineSeg() {
  const box = $('machineSeg');
  const newest = newestVersion();
  const html = sortedLinks()
    .map((l) => {
      const st = l.status;
      const label = !l.open ? 'mất kết nối' : !st ? '…' : esc(appOf(st.app).label?.(st.apps?.[st.app] ?? {}) ?? st.apps?.[st.app]?.name ?? '');
      // Sidecar cũ: version nhỏ hơn máy khác.
      const old = l.open && st && (!st.version || st.version < newest);
      const upd = old && st.version ? `<span class="upd" data-upd="${links.indexOf(l)}">Cập nhật</span>` : old ? '<small>bản cũ</small>' : '';
      return `<button type="button" data-li="${links.indexOf(l)}" class="${l === S.view ? 'on' : ''}${l.open ? '' : ' off'}">Máy ${esc(l.name || '…')}<small>${l === S.view ? 'đang xem · ' : ''}${label}</small>${upd}</button>`;
    })
    .join('');
  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
  }
}
$('machineSeg').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const upd = t.closest<HTMLElement>('[data-upd]');
  if (upd) {
    const l = links[Number(upd.dataset.upd)];
    if (l) sendTo(l, { type: 'update' });
    toast(`Đang cập nhật máy ${l?.name}…`);
    return;
  }
  const b = t.closest<HTMLElement>('[data-li]');
  const l = b && links[Number(b.dataset.li)];
  if (!l || l === S.view) return;
  switchView(l);
  openSheet(false);
});

// Hàng chọn app của máy đang xem (ẩn khi máy chỉ có một app).
function renderAppSeg(st: any) {
  const box = $('appSeg');
  const ids = st?.apps ? Object.keys(st.apps) : [];
  $('appRow').hidden = ids.length < 2;
  const html = ids
    .map((id) => {
      const wa = appOf(id);
      const a = st.apps[id];
      return `<button type="button" data-app="${esc(id)}" class="${st.app === id ? 'on' : ''}">${wa.icon}<span>${esc(a.name)}</span></button>`;
    })
    .join('');
  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
  }
}
$('appSeg').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-app]');
  if (!b) return;
  selectApp(b.dataset.app!);
});

/** Chuyển máy đang xem sang app khác (nhớ lại cho lần sau). */
function selectApp(id: string, l: Link = S.view) {
  prefs.apps = { ...prefs.apps, [l.name]: id };
  savePrefs();
  sendTo(l, { type: 'app', id });
}

Object.assign(actions, {
  switchView,
  openSheet,
  selectApp,
  sendView: () => sendView(),
  render,
  stats: () => ({ frameCount, keyCount, bytes, drawn: S.drawn, codec, size: `${canvas.width}x${canvas.height}` }),
});
for (const a of WEB_APPS) a.init();

// Máy chủ của trang trước, rồi các máy đã biết từ lần trước (máy chủ có tắt thì vẫn vào được máy kia).
S.view = ensureLink(homeUrl, isLocalPage ? prefs.home : pageMachine(prefs.machines)?.name);
for (const m of prefs.machines ?? []) {
  const url = machineUrl(m);
  if (url) ensureLink(url, m.name);
}
if (prefs.view) {
  const l = links.find((x) => x.name === prefs.view);
  if (l) S.view = l;
}
// Lưu vỏ trang để mở được cả khi máy chủ của trang đang tắt.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
render();

