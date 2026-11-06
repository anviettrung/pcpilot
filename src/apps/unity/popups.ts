// Hộp thoại (popup) của Unity Editor: tìm, chụp ảnh, bấm từ điện thoại.
// Unity hay dừng ở hộp thoại modal ("Recovering Scene Backups", "Save scene?", "Safe Mode"...) mà người dùng không ngồi
// trước máy thì không ai trả lời được. Việc Win32 do scripts/win-helper.ps1 làm (một tiến trình PowerShell giữ suốt,
// nói chuyện qua stdin/stdout từng dòng JSON).
import { resolve } from 'node:path';
import type { Subprocess } from 'bun';

export interface PopupButton {
  hwnd: number;
  text: string;
}

export interface RawPopup {
  hwnd: number;
  pid: number;
  title: string;
  cls: string;
  w: number;
  h: number;
  buttons: PopupButton[];
}

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

export class WinHelper {
  private proc: Subprocess<'pipe', 'pipe', 'ignore'> | null = null;
  private seq = 0;
  private waiting = new Map<number, { done: (v: any) => void; fail: (e: Error) => void; timer: Timer }>();
  private stopped = false;

  constructor(private script = resolve(import.meta.dir, '..', '..', '..', 'scripts', 'win-helper.ps1')) {
    this.start();
  }

  private start() {
    if (this.stopped) return;
    const p = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      windowsHide: true,
    });
    this.proc = p;
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of p.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const m = JSON.parse(line);
            const w = this.waiting.get(m.id);
            if (w) {
              this.waiting.delete(m.id);
              clearTimeout(w.timer);
              w.done(m);
            }
          } catch {}
        }
      }
    })();
    p.exited.then((code) => {
      if (this.proc !== p) return;
      this.proc = null;
      for (const w of this.waiting.values()) w.fail(new Error('win-helper đã thoát'));
      this.waiting.clear();
      if (!this.stopped) {
        log(`win-helper thoát (mã ${code}), chạy lại sau 3 giây`);
        setTimeout(() => this.start(), 3000);
      }
    });
  }

  call(op: string, args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any> {
    const p = this.proc;
    if (!p) return Promise.reject(new Error('win-helper chưa chạy'));
    const id = ++this.seq;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        fail(new Error(`win-helper không trả lời lệnh ${op}`));
      }, timeoutMs);
      this.waiting.set(id, { done, fail, timer });
      p.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
      p.stdin.flush();
    });
  }

  stop() {
    this.stopped = true;
    this.proc?.kill();
  }
}

/** Cửa sổ tiến trình ("Hold on (busy for …)", "Opening project...", "Importing…") chỉ để chờ, không cần trả lời. */
export const isProgressTitle = (t: string) => /^Hold on\b/i.test(t) || /(\.\.\.|…)\s*$/.test(t);
