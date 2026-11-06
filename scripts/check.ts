export {};
// Client WebSocket tối giản (không giải mã): đếm khung nhận được trong N giây, tuỳ chọn chạm một điểm.
// Dùng để kiểm Unity còn stream khi bị thu nhỏ / mất focus (scripts/focus.ps1), và thử bấm nút UI trong game.
//   bun run scripts/check.ts [giây] [x,y để chạm] [lệnh: play|stop|pause] [app: unity]
const [secs = '8', tap = '', cmd = '', app = ''] = process.argv.slice(2);
const port = Number(process.env.UNITYPILOT_PORT ?? 7440);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
ws.binaryType = 'arraybuffer';
let frames = 0, keys = 0, bytes = 0;
let status: any = null;
const perSec: number[] = [];
let thisSec = 0;
ws.onmessage = (e) => {
  if (typeof e.data === 'string') {
    const m = JSON.parse(e.data);
    if (m.type === 'status') status = m;
    return;
  }
  const b = new Uint8Array(e.data as ArrayBuffer);
  frames++;
  thisSec++;
  bytes += b.length;
  if (b[1] === 1) keys++;
};
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ type: 'hello', watch: true, w: 390, h: 800, quality: 'high', fps: 30, ...(app ? { app } : {}) }));
if (cmd) ws.send(JSON.stringify({ type: 'cmd', cmd }));
const t = setInterval(() => {
  perSec.push(thisSec);
  thisSec = 0;
}, 1000);
if (tap && tap !== '-') {
  await Bun.sleep(2000);
  const [x, y] = tap.split(',').map(Number);
  ws.send(JSON.stringify({ type: 'touch', seq: 1, p: [{ id: 0, ph: 'down', x, y }] }));
  await Bun.sleep(80);
  ws.send(JSON.stringify({ type: 'touch', seq: 2, p: [{ id: 0, ph: 'up', x, y }] }));
}
await Bun.sleep(Number(secs) * 1000);
clearInterval(t);
ws.close();
console.log(JSON.stringify({ frames, keys, kbps: Math.round((bytes * 8) / Number(secs) / 1000), perSec, app: status?.app, appState: status?.apps?.[status?.app], stream: status?.stream }));
process.exit(0);
