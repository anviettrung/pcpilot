// Chụp giao diện PWA ở các trạng thái (cỡ điện thoại) bằng Chrome headless qua DevTools Protocol.
//   bun run scripts/ui-shots.ts [thư mục ra]       mặc định: shots/ui
// Không gửi chạm hay lệnh nào sang máy (không Play, không mở/tắt project): chỉ mở bảng ☰ và thông số đo.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const out = process.argv[2] ?? resolve(import.meta.dir, '..', 'shots', 'ui');
mkdirSync(out, { recursive: true });
const base = process.env.PROBE_BASE ?? 'http://127.0.0.1:7440';
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find((p) => Bun.file(p).size > 0);
if (!chrome) throw new Error('Không thấy Chrome hay Edge');
const dbg = 9351;
const proc = Bun.spawn([chrome, '--headless=new', '--hide-scrollbars', `--remote-debugging-port=${dbg}`,
  `--user-data-dir=${join(tmpdir(), 'unitypilot-ui-profile')}`, 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });

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
  const js = async (expression: string) => (await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  const shot = async (name: string, wait = 900) => {
    await Bun.sleep(wait);
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    await Bun.write(join(out, `${name}.png`), Buffer.from(r.data, 'base64'));
    console.log('đã chụp', name);
  };
  const size = (width: number, height: number) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  await size(390, 844);
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp('Page.navigate', { url: `${base}/?app=unity` });
  await Bun.sleep(800);
  await js("localStorage.removeItem('unitypilot:prefs')");
  await cdp('Page.reload');
  await Bun.sleep(2500);
  await shot('1-unity-doc', 500);
  await js("document.getElementById('menuBtn').click()");
  await shot('2-bang-cai-dat-project', 1500);
  await js("document.getElementById('metricsBox').open = true; document.getElementById('sheet').scrollTop = 1e4");
  await shot('3-thong-so', 1500);
  await js("document.getElementById('closeSheet').click()");

  await size(844, 390);
  await shot('4-unity-ngang', 1500);
} finally {
  proc.kill();
}
