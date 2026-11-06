// Tiến trình gửi phím quyền admin của PcPilot (Scheduled Task "PcPilot Input", RunLevel Highest).
// Windows (UIPI) lặng lẽ bỏ phím SendInput từ tiến trình quyền thấp hơn cửa sổ nhận: app chạy quyền admin (nhiều
// game, công cụ hệ thống) chỉ nhận phím từ tiến trình quyền admin. Phần này chỉ làm đúng việc đó, mọi thứ khác (web, stream, Unity)
// nằm ở sidecar quyền thường (src/main.ts).
// Nghe ở 127.0.0.1:<inputPort>. Kết nối nào cũng phải gửi đúng mã bí mật ở dòng đầu: mã đổi mỗi lần khởi động, ghi ở
// %LOCALAPPDATA%\pcpilot\input-token.txt (chỉ người dùng của máy đọc được).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Socket } from 'bun';
import { INPUT_PORT, log } from './core/config';
import { TOKEN_FILE } from './screen/bridge';
import { focusWindow, isKey, isMouseAction, sendKey, sendMouse, sendText } from './screen/input';

const token = randomBytes(24).toString('hex');
mkdirSync(dirname(TOKEN_FILE), { recursive: true });
writeFileSync(TOKEN_FILE, token + '\n');

interface Conn {
  buf: string;
  ok: boolean;
  /** Phím kết nối này đang giữ: mất kết nối thì nhả hết. */
  held: Set<string>;
}

function handle(s: Socket<Conn>, m: any) {
  const c = s.data;
  if (!c.ok) {
    if (m.t !== token) return void s.end();
    c.ok = true;
    return;
  }
  const reply = (ok: boolean, data?: unknown) => m.id && s.write(JSON.stringify({ id: m.id, ok, data }) + '\n');
  switch (m.op) {
    case 'key': {
      const code = String(m.k);
      if (!isKey(code)) return reply(false);
      if (m.down) c.held.add(code);
      else c.held.delete(code);
      return reply(sendKey(code, !!m.down));
    }
    case 'text':
      return reply(sendText(String(m.s ?? '')));
    case 'mouse': {
      const a = String(m.a);
      if (!isMouseAction(a) || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return reply(false);
      return reply(sendMouse(m.x, m.y, a, Number(m.d) || 0));
    }
    case 'focus':
      return reply(focusWindow(BigInt(String(m.hwnd ?? '0'))));
    case 'ping':
      return reply(true);
    case 'quit':
      // install.ps1 (quyền thường) không tắt được tiến trình quyền admin: nhờ nó tự thoát, vòng lặp
      // scripts/run-sidecar.ps1 (cũng quyền admin) chạy lại bằng mã mới.
      log('thoát theo yêu cầu (cập nhật bản mới)');
      reply(true);
      setTimeout(() => process.exit(0), 100);
  }
}

function releaseAll(c: Conn) {
  for (const k of c.held) sendKey(k, false);
  if (c.held.size) log(`nhả các phím còn giữ: ${[...c.held].join(', ')}`);
  c.held.clear();
}

const conns = new Set<Socket<Conn>>();
Bun.listen<Conn>({
  hostname: '127.0.0.1',
  port: INPUT_PORT,
  socket: {
    open: (s) => {
      s.data = { buf: '', ok: false, held: new Set() };
      conns.add(s);
    },
    data: (s, d) => {
      s.data.buf += d.toString();
      if (s.data.buf.length > 1 << 20) return void s.end();
      let i: number;
      while ((i = s.data.buf.indexOf('\n')) >= 0) {
        const line = s.data.buf.slice(0, i);
        s.data.buf = s.data.buf.slice(i + 1);
        try {
          handle(s, JSON.parse(line));
        } catch {}
      }
    },
    close: (s) => {
      conns.delete(s);
      releaseAll(s.data);
    },
    error: () => {},
  },
});
for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const)
  process.on(sig, () => {
    for (const s of conns) releaseAll(s.data);
    if (sig !== 'exit') process.exit(0);
  });

log(`pcpilot input (quyền admin) tại 127.0.0.1:${INPUT_PORT}`);
