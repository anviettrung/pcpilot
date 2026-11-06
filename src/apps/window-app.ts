// Khuôn cho app chụp theo một cửa sổ cố định (game, phần mềm): tìm cửa sổ theo lớp (và tiêu đề), chụp đúng vùng
// client của nó (cắt thêm viền nếu khai `crop`), phím chuột gửi vào vùng đó. Thêm app mới kiểu này chỉ cần một khai báo,
// vd trong src/apps/index.ts:
//   new WindowApp({ id: 'mygame', name: 'My Game', windowClass: 'MyGameWindowClass', requireForeground: true })
// (lớp cửa sổ xem bằng Spy++ hay scripts/win-helper.ps1), rồi thêm screenApp cùng id trong web/apps/index.ts.
// Game có anti-cheat: bật requireForeground để chỉ gửi phím chuột khi cửa sổ game đang ở trên cùng.
import type { App, Host, ScreenRegion } from './types';
import { findWindowByClass, type WindowInfo } from '../screen/win32';

export interface WindowAppSpec {
  id: string;
  name: string;
  /** Lớp cửa sổ (Spy++ / GetClassName). Có nhiều cửa sổ cùng lớp thì lấy cái lớn nhất. */
  windowClass: string;
  title?: RegExp;
  /** Cắt bớt mỗi cạnh của vùng client, pixel (vd thanh công cụ của app). */
  crop?: { left?: number; top?: number; right?: number; bottom?: number };
  /** Chỉ gửi phím chuột khi cửa sổ đang ở trên cùng. */
  requireForeground?: boolean;
}

export class WindowApp implements App {
  source = 'screen' as const;
  id: string;
  name: string;
  requireForeground: boolean;
  private win: WindowInfo | null = null;
  private state = 'unknown';
  private checkedAt = 0;

  constructor(private spec: WindowAppSpec) {
    this.id = spec.id;
    this.name = spec.name;
    this.requireForeground = !!spec.requireForeground;
  }

  init(_host: Host) {}

  region(): ScreenRegion | string {
    this.checkedAt = Date.now();
    const w = (this.win = findWindowByClass(this.spec.windowClass, this.spec.title));
    if (!w) return (this.state = 'offline');
    if (w.minimized) return (this.state = 'minimized');
    const c = this.spec.crop ?? {};
    const x = w.x + (c.left ?? 0), y = w.y + (c.top ?? 0);
    const ww = w.w - (c.left ?? 0) - (c.right ?? 0), hh = w.h - (c.top ?? 0) - (c.bottom ?? 0);
    if (ww < 64 || hh < 64) return (this.state = 'offscreen');
    this.state = 'ok';
    return { x, y, w: ww, h: hh, monitor: w.monitor, hwnd: w.hwnd, cls: this.spec.windowClass };
  }

  status() {
    // App không đang xem thì không ai gọi region(): tự tìm lại cửa sổ để trạng thái không cũ.
    if (Date.now() - this.checkedAt > 1500) this.region();
    const w = this.win;
    return w ? { state: this.state, w: w.w, h: w.h, foreground: w.foreground, title: w.title } : { state: this.state };
  }
}
