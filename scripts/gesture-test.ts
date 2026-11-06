// Thử cử chỉ chạm của app Màn hình trong Chrome headless: chạm, kéo, giữ lâu, hai ngón cuộn, chụm phóng to, chạm hai
// ngón. Lệnh chuột, phím bị chặn ngay trong trang (không gửi sang máy), chỉ ghi lại để in ra so với điều mong đợi.
//   bun run scripts/gesture-test.ts
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const base = process.env.PROBE_BASE ?? 'http://127.0.0.1:7440';
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find((p) => Bun.file(p).size > 0);
if (!chrome) throw new Error('Không thấy Chrome hay Edge');
const dbg = 9353;
const proc = Bun.spawn([chrome, '--headless=new', '--hide-scrollbars', `--remote-debugging-port=${dbg}`,
  `--user-data-dir=${join(tmpdir(), 'pcpilot-gesture-profile')}`, 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
const before = await fetch(`${base}/api/status`).then((r) => r.json()).catch(() => null);

// Chặn lệnh thao tác trước khi trang chạy: ghi vào window.__sent thay vì gửi đi.
const hook = `(() => {
  window.__sent = [];
  const orig = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    try { const m = JSON.parse(d); if (['mouse', 'key', 'text', 'focus'].includes(m.type)) { window.__sent.push(m); return; } } catch {}
    return orig.call(this, d);
  };
})();`;

let failed = 0;
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
  const touch = (type: string, pts: [number, number][]) =>
    cdp('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  const take = async () => (await js('JSON.stringify(window.__sent.splice(0))')) as string;
  const check = (name: string, got: any[], ok: boolean) => {
    console.log(`${ok ? 'đạt ' : 'HỎNG'}  ${name}: ${got.map((m) => (m.a ?? `${m.k}${m.down ? '↓' : '↑'}`) + (m.d ? `(${m.d})` : '')).join(' ')}`);
    if (!ok) failed++;
  };

  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: hook });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp('Page.navigate', { url: `${base}/?app=desktop` });
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(500);
    if (await js("document.getElementById('overlay').hidden")) break;
  }
  await Bun.sleep(1500);
  await js("localStorage.setItem('pcpilot:prefs', JSON.stringify({...JSON.parse(localStorage.getItem('pcpilot:prefs')||'{}'), showTouches:false}))");
  const [cx, cy] = (await js("(()=>{const r=document.getElementById('video').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()")) as number[];
  await take();

  // Chạm nhẹ: move rồi down + up tại một chỗ.
  await touch('touchStart', [[cx, cy]]);
  await Bun.sleep(80);
  await touch('touchEnd', []);
  await Bun.sleep(200);
  let s = JSON.parse(await take());
  check('chạm nhẹ = click trái', s, s.map((m: any) => m.a).join() === 'move,down,up');

  // Kéo: down ở điểm đầu, các move, up.
  await touch('touchStart', [[cx - 100, cy]]);
  for (let i = 1; i <= 10; i++) {
    await Bun.sleep(20);
    await touch('touchMove', [[cx - 100 + i * 15, cy]]);
  }
  await touch('touchEnd', []);
  await Bun.sleep(200);
  s = JSON.parse(await take());
  const a = s.map((m: any) => m.a);
  check('kéo = giữ chuột trái', s, a[0] === 'move' && a[1] === 'down' && a.at(-1) === 'up' && a.includes('move', 2) && s[1].x < s.at(-1).x);

  // Giữ yên: click phải.
  await touch('touchStart', [[cx, cy]]);
  await Bun.sleep(700);
  await touch('touchEnd', []);
  await Bun.sleep(200);
  s = JSON.parse(await take());
  check('giữ yên = click phải', s, s.map((m: any) => m.a).join() === 'move,rdown,rup');

  // Hai ngón kéo lên (chưa phóng to): cuộn.
  await touch('touchStart', [[cx - 40, cy + 60], [cx + 40, cy + 60]]);
  for (let i = 1; i <= 12; i++) {
    await Bun.sleep(20);
    await touch('touchMove', [[cx - 40, cy + 60 - i * 8], [cx + 40, cy + 60 - i * 8]]);
  }
  await touch('touchEnd', []);
  await Bun.sleep(200);
  s = JSON.parse(await take());
  check('hai ngón kéo = cuộn', s, s.length > 0 && s.every((m: any) => m.a === 'wheel') && s.some((m: any) => m.d < 0));

  // Chụm mở: phóng to, không gửi gì.
  await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
  for (let i = 1; i <= 10; i++) {
    await Bun.sleep(20);
    await touch('touchMove', [[cx - 30 - i * 12, cy], [cx + 30 + i * 12, cy]]);
  }
  await touch('touchEnd', []);
  await Bun.sleep(300);
  s = JSON.parse(await take());
  const z = (await js("document.getElementById('video').style.transform")) as string;
  const zoomBtn = (await js("!document.getElementById('zoomBtn').hidden")) as boolean;
  check(`chụm mở = phóng to (${z || 'không'}), nút 1× ${zoomBtn ? 'hiện' : 'ẩn'}`, s, s.length === 0 && /scale\(([\d.]+)\)/.test(z) && Number(/scale\(([\d.]+)\)/.exec(z)![1]) > 2 && zoomBtn);

  // Đã phóng to: chạm vẫn click đúng chỗ dưới ngón (toạ độ đã tính phần phóng).
  await touch('touchStart', [[cx, cy]]);
  await Bun.sleep(80);
  await touch('touchEnd', []);
  await Bun.sleep(200);
  s = JSON.parse(await take());
  check(`phóng to rồi chạm giữa màn: click ở (${s[1]?.x?.toFixed(3)}, ${s[1]?.y?.toFixed(3)})`, s, s.length === 3 && Math.abs(s[1].x - 0.5) < 0.02 && Math.abs(s[1].y - 0.5) < 0.02);

  await js("document.getElementById('zoomBtn').click()");
  // Chạm nhẹ hai ngón: click phải.
  await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
  await Bun.sleep(80);
  await touch('touchEnd', []);
  await Bun.sleep(200);
  s = JSON.parse(await take());
  check('chạm nhẹ hai ngón = click phải', s, s.map((m: any) => m.a).join() === 'move,rdown,rup');

  // Bàn phím: Ctrl rồi "c" thành phím C thật kèm Ctrl.
  await js("document.getElementById('kbdBtn').click(); document.querySelector('[data-mod=ControlLeft]').click(); document.querySelector('[data-key=Tab]').click()");
  await Bun.sleep(200);
  s = JSON.parse(await take());
  check('Ctrl + Tab', s, s.map((m: any) => `${m.k}${m.down ? '↓' : '↑'}`).join(' ') === 'ControlLeft↓ Tab↓ Tab↑ ControlLeft↑');
} finally {
  if (before?.app) {
    const w = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
    await new Promise((r) => (w.onopen = r));
    w.send(JSON.stringify({ type: 'hello', watch: true, app: before.app }));
    await Bun.sleep(300);
    w.close();
  }
  proc.kill();
}
process.exit(failed ? 1 : 0);
