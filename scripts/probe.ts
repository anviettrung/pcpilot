// Đo thử cả chuỗi với Unity trên chính máy này: mở PWA trong Chrome headless (cỡ điện thoại) ở chế độ ?autotest, chờ xong,
// in kết quả và chụp màn hình trang.
//   bun run scripts/probe.ts <label> [scene] [giây] [quality] [fps]     (PROBE_JPEG=1: thử JPEG, PROBE_NOTAP=1: không chạm, PROBE_ASPECT=16:9|iphonex|ipad)
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const [label = 'probe', scene = '', seconds = '20', quality = 'high', fps = '30'] = process.argv.slice(2);
const port = Number(process.env.PCPILOT_PORT ?? 7440);
const out = resolve(import.meta.dir, '..', 'shots');
mkdirSync(out, { recursive: true });

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find((p) => Bun.file(p).size > 0);
if (!chrome) throw new Error('Không thấy Chrome hay Edge');
const dbg = 9349;
const profile = join(tmpdir(), 'pcpilot-probe-profile');
const proc = Bun.spawn([chrome, '--headless=new', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`, 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });

try {
  let page: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 50 && !page; i++) {
    await Bun.sleep(200);
    page = await fetch(`http://127.0.0.1:${dbg}/json/list`).then((r) => r.json()).then((l: any[]) => l.find((t) => t.type === 'page')).catch(() => undefined);
  }
  if (!page) throw new Error('Chrome không mở cổng debug');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const waiting = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && waiting.has(m.id)) waiting.get(m.id)!(m.result ?? m.error);
  };
  const cdp = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((r) => {
      const id = ++seq;
      waiting.set(id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const q = new URLSearchParams({ app: 'unity', autotest: seconds, label, play: '1', ...(scene ? { scene } : {}), ...(process.env.PROBE_JPEG ? { jpeg: '1' } : {}), ...(process.env.PROBE_NOTAP ? { taps: '0' } : {}) });
  await cdp('Runtime.evaluate', { expression: `localStorage.setItem('pcpilot:prefs', '${JSON.stringify({ quality, fps: Number(fps), aspect: process.env.PROBE_ASPECT ?? 'free' })}')` });
  await cdp('Page.navigate', { url: `${process.env.PROBE_BASE ?? `http://127.0.0.1:${port}`}/?${q}` });
  await Bun.sleep(1000);
  await cdp('Runtime.evaluate', { expression: `localStorage.setItem('pcpilot:prefs', '${JSON.stringify({ quality, fps: Number(fps), aspect: process.env.PROBE_ASPECT ?? 'free' })}')` });
  await cdp('Page.reload');

  const deadline = Date.now() + (Number(seconds) + 60) * 1000;
  let title = '';
  while (Date.now() < deadline) {
    await Bun.sleep(1000);
    title = (await cdp('Runtime.evaluate', { expression: 'document.title', returnByValue: true }))?.result?.value ?? '';
    if (title.startsWith('DONE ')) break;
  }
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  const file = join(out, `page-${label}.png`);
  if (shot?.data) await Bun.write(file, Buffer.from(shot.data, 'base64'));
  if (!title.startsWith('DONE ')) {
    const metrics = (await cdp('Runtime.evaluate', { expression: "document.getElementById('overlayText').innerText + ' | ' + document.getElementById('metrics').textContent", returnByValue: true }))?.result?.value;
    console.log('CHƯA XONG:', metrics);
  } else console.log(JSON.stringify(JSON.parse(title.slice(5)), null, 2));
  console.log('ảnh trang:', file);
} finally {
  proc.kill();
}
