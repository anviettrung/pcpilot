// Đường gửi phím và chuột của sidecar. Sidecar chạy quyền thường (để Unity mở từ trang cũng chạy quyền thường), nên
// gửi qua tiến trình phụ quyền admin (src/elevated.ts, Scheduled Task "PcPilot Input") nếu có: cửa sổ quyền admin
// (nhiều game, công cụ hệ thống) mới nhận. Chưa có tiến trình phụ thì tự gửi, chỉ tới được cửa sổ quyền thường.
// Giao thức: TCP 127.0.0.1, mỗi dòng một JSON. Dòng đầu là mã bí mật tiến trình phụ ghi ra tệp lúc khởi động.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'bun';
import { log } from '../core/config';
import { focusWindow, sendKey, sendMouse, sendText, type MouseAction } from './input';

export const TOKEN_FILE = join(process.env.LOCALAPPDATA ?? '.', 'pcpilot', 'input-token.txt');

export class InputBridge {
  private sock: Socket<undefined> | null = null;
  private connecting = false;
  private seq = 0;
  private waiting = new Map<number, (ok: boolean, data?: any) => void>();
  private buf = '';
  private warned = false;

  constructor(private port: number) {
    this.connect();
    setInterval(() => this.connect(), 5000);
  }

  /** Đang gửi qua tiến trình phụ quyền admin. */
  get elevated() {
    return !!this.sock;
  }

  private connect() {
    if (this.sock || this.connecting || !existsSync(TOKEN_FILE)) return;
    let token = '';
    try {
      token = readFileSync(TOKEN_FILE, 'utf8').trim();
    } catch {
      return;
    }
    this.connecting = true;
    Bun.connect({
      hostname: '127.0.0.1',
      port: this.port,
      socket: {
        open: (s) => {
          s.write(JSON.stringify({ t: token }) + '\n');
          this.sock = s;
          this.connecting = false;
          this.warned = false;
          log('đã nối tiến trình gửi phím quyền admin');
        },
        data: (_s, d) => this.onData(d),
        close: (s) => {
          if (this.sock === s) {
            this.sock = null;
            log('mất tiến trình gửi phím quyền admin, tự gửi bằng quyền thường');
          }
          this.connecting = false;
          for (const w of this.waiting.values()) w(false);
          this.waiting.clear();
        },
        error: () => {
          this.connecting = false;
        },
        connectError: () => {
          this.connecting = false;
          if (!this.warned) log('chưa có tiến trình gửi phím quyền admin (task PcPilot Input)');
          this.warned = true;
        },
      },
    }).catch(() => (this.connecting = false));
  }

  private onData(d: Buffer) {
    this.buf += d.toString();
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        const w = this.waiting.get(m.id);
        if (w) {
          this.waiting.delete(m.id);
          w(!!m.ok, m.data);
        }
      } catch {}
    }
  }

  private post(m: Record<string, unknown>) {
    this.sock!.write(JSON.stringify(m) + '\n');
  }

  private ask(m: Record<string, unknown>, timeoutMs = 3000): Promise<{ ok: boolean; data?: any }> {
    const id = ++this.seq;
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        done({ ok: false });
      }, timeoutMs);
      this.waiting.set(id, (ok, data) => {
        clearTimeout(timer);
        done({ ok, data });
      });
      this.post({ ...m, id });
    });
  }

  key(code: string, down: boolean): boolean {
    if (this.sock) return this.post({ op: 'key', k: code, down }), true;
    return sendKey(code, down);
  }

  text(s: string): boolean {
    if (this.sock) return this.post({ op: 'text', s }), true;
    return sendText(s);
  }

  mouse(x: number, y: number, a: MouseAction, d = 0): boolean {
    if (this.sock) return this.post({ op: 'mouse', x, y, a, d }), true;
    return sendMouse(x, y, a, d);
  }

  /** Nhờ tiến trình quyền admin tự thoát (có bản mới): vòng lặp của nó chạy lại bằng mã mới. */
  quit() {
    if (this.sock) this.post({ op: 'quit' });
  }

  /** Tiến trình quyền admin đưa cửa sổ lên trên được cả khi cửa sổ đang trên cùng là app quyền admin. */
  async focus(hwnd: bigint): Promise<boolean> {
    if (this.sock) return (await this.ask({ op: 'focus', hwnd: String(hwnd) })).ok;
    return focusWindow(hwnd);
  }
}
