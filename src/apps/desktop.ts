// Remote màn hình: xem và điều khiển cả một màn hình, hoặc một cửa sổ bất kỳ (chỉ vùng client của nó, theo nó khi
// dời chỗ hay đổi cỡ). Là nền cho mọi app chụp màn hình; app riêng (WindowApp) thêm luật và giao diện riêng.
//
// Chế độ điện thoại: xoay màn hình máy theo cách cầm điện thoại (hay luôn dọc) và tăng cỡ chữ của Windows, để nhìn rõ
// trên màn hình nhỏ. Máy chỉ đổi khi người xem bật, và trả về như cũ khi: tắt chế độ, đổi sang app khác, không ai
// xem quá 1 phút, sidecar thoát. Mức cũ ghi ra tệp trước khi đổi: sidecar chết ngang thì lần khởi động sau trả về.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { App, Client, Host, ScreenRegion, WS } from './types';
import { getOrientation, getScale, setOrientation, setScale, type Orientation } from '../screen/display';
import { listMonitors, listWindows, windowInfo, type Monitor, type WindowInfo } from '../screen/win32';

type Target = { kind: 'monitor'; idx: number } | { kind: 'window'; hwnd: bigint; title: string; cls: string };

const SAVED_FILE = join(process.env.LOCALAPPDATA ?? '.', 'pcpilot', 'display-saved.json');
/** Không còn ai xem bao lâu thì trả màn hình về như cũ (khoá điện thoại một lát thì chưa trả). */
const IDLE_MS = 60_000;
/** Điện thoại phải giữ một chiều bao lâu mới xoay máy theo (khỏi xoay qua lại khi lắc tay). */
const STEADY_MS = 1_200;

interface Saved {
  device: string;
  orientation: Orientation;
  scale: number;
}

export class DesktopApp implements App {
  id = 'desktop';
  name = 'Màn hình';
  source = 'screen' as const;
  private host!: Host;
  private target: Target = { kind: 'monitor', idx: 0 };
  private monitors: Monitor[] = [];
  private win: WindowInfo | null = null;
  private state = 'ok';
  // --- Chế độ điện thoại ---
  private saved: Saved | null = null;
  private desired: Client['mobile'] | null = null;
  private portrait = false;
  private portraitSince = 0;
  private lastViewerAt = 0;
  private display: { device: string; orientation: number; scale: number; options: number[] } | null = null;
  private busy = false;

  init(host: Host) {
    this.host = host;
    this.monitors = listMonitors();
    try {
      if (existsSync(SAVED_FILE)) {
        this.saved = JSON.parse(readFileSync(SAVED_FILE, 'utf8'));
        host.log('lần trước chưa trả màn hình về như cũ: trả bây giờ');
        this.restore();
      }
    } catch {}
    setInterval(() => this.tick(), 1000);
  }

  shutdown() {
    this.restore();
  }

  region(): ScreenRegion | string {
    if (this.target.kind === 'monitor') {
      this.monitors = listMonitors();
      const m = this.monitors[this.target.idx] ?? this.monitors[0];
      if (!m) return (this.state = 'monitor');
      this.state = 'ok';
      this.win = null;
      return { ...m, monitor: m };
    }
    const w = (this.win = windowInfo(this.target.hwnd));
    if (!w) return (this.state = 'gone');
    if (w.minimized) return (this.state = 'minimized');
    if (w.w < 64 || w.h < 64) return (this.state = 'offscreen');
    this.state = 'ok';
    return { x: w.x, y: w.y, w: w.w, h: w.h, monitor: w.monitor, hwnd: w.hwnd };
  }

  /** Màn hình đang xem (chế độ điện thoại đổi màn hình này). */
  private device(): string {
    if (this.target.kind === 'window') return this.win?.monitor.device ?? '';
    return (this.monitors[this.target.idx] ?? this.monitors[0])?.device ?? '';
  }

  // --- Chế độ điện thoại ----------------------------------------------------------------------------
  private tick() {
    const now = Date.now();
    const viewers = [...this.host.clients.values()].filter((c) => c.watch);
    const last = viewers.at(-1);
    if (last) {
      this.lastViewerAt = now;
      this.desired = last.mobile.on ? { ...last.mobile } : null;
      const p = last.viewH > last.viewW;
      if (p !== this.portrait) [this.portrait, this.portraitSince] = [p, now];
    } else if (now - this.lastViewerAt > IDLE_MS) this.desired = null;
    if (!this.host.isActive(this.id)) this.desired = null;

    const device = this.device();
    if (device) {
      const sc = getScale(device);
      this.display = { device, orientation: getOrientation(device) ?? 0, scale: sc?.percent ?? 100, options: sc?.options ?? [] };
    }
    if (this.busy) return;
    if (!this.desired || !device) return void (this.saved && this.restore());
    if (this.saved && this.saved.device !== device) this.restore(); // đổi sang màn hình khác: trả màn hình cũ trước

    const cur = this.display!;
    const orig = this.saved ?? { device, orientation: cur.orientation as Orientation, scale: cur.scale };
    const d = this.desired;
    // Dọc khi: luôn dọc, hoặc theo điện thoại mà điện thoại đã cầm dọc đủ lâu. Không thì giữ chiều ban đầu.
    const steady = now - this.portraitSince >= STEADY_MS;
    let o: Orientation = orig.orientation;
    if (d.rotate === 'portrait' || (d.rotate === 'auto' && this.portrait)) o = orig.orientation % 2 ? orig.orientation : 1;
    if (d.rotate === 'auto' && !steady) o = cur.orientation as Orientation;
    const scale = d.scale || orig.scale;
    if (o === cur.orientation && scale === cur.scale) return;
    if (o === orig.orientation && scale === orig.scale) return void this.restore();
    this.apply(orig, o, scale);
  }

  private apply(orig: Saved, o: Orientation, scale: number) {
    if (!this.saved) {
      this.saved = orig;
      mkdirSync(dirname(SAVED_FILE), { recursive: true });
      writeFileSync(SAVED_FILE, JSON.stringify(orig));
    }
    const { device } = orig;
    this.busy = true;
    try {
      const okO = getOrientation(device) === o || setOrientation(device, o);
      // Cỡ chữ đặt sau khi xoay: mức chọn được phụ thuộc độ phân giải.
      const okS = getScale(device)?.percent === scale || setScale(device, scale);
      this.host.log(`chế độ điện thoại: ${device} ${o % 2 ? 'dọc' : 'ngang'} ${scale}%${okO && okS ? '' : ' (có phần không đổi được)'}`);
    } finally {
      this.busy = false;
    }
    setTimeout(() => this.host.refresh(), 1500);
  }

  private restore() {
    const s = this.saved;
    if (!s) return;
    this.saved = null;
    try {
      setScale(s.device, s.scale);
      setOrientation(s.device, s.orientation);
      this.host?.log(`trả màn hình ${s.device} về như cũ (${s.orientation % 2 ? 'dọc' : 'ngang'} ${s.scale}%)`);
    } catch {}
    rmSync(SAVED_FILE, { force: true });
    if (this.host) setTimeout(() => this.host.refresh(), 1500);
  }

  status() {
    const t = this.target;
    return {
      state: this.state,
      target: t.kind === 'monitor' ? { kind: 'monitor', idx: t.idx } : { kind: 'window', hwnd: String(t.hwnd), title: this.win?.title || t.title },
      monitors: this.monitors.map((m) => ({ w: m.w, h: m.h, primary: m.primary })),
      foreground: this.win?.foreground ?? true,
      display: this.display && { ...this.display, changed: !!this.saved, original: this.saved && { orientation: this.saved.orientation, scale: this.saved.scale } },
    };
  }

  onMessage(ws: WS, _c: Client, m: any): boolean {
    if (m.type !== 'desktop') return false;
    if (m.op === 'windows') {
      ws.send(JSON.stringify({ type: 'windows', list: listWindows() }));
    } else if (m.op === 'monitor') {
      const idx = Math.max(0, Math.min(this.monitors.length - 1, Number(m.idx) | 0));
      this.target = { kind: 'monitor', idx };
      this.host.log(`remote màn hình: màn hình ${idx + 1}`);
    } else if (m.op === 'window') {
      let hwnd = 0n;
      try {
        hwnd = BigInt(String(m.hwnd));
      } catch {}
      const w = windowInfo(hwnd);
      // Chỉ nhận cửa sổ đang có trong danh sách (cửa sổ ứng dụng), không nhận handle tuỳ ý.
      if (!w || !listWindows().some((x) => x.hwnd === String(hwnd))) {
        this.host.notice(ws, 'Cửa sổ này không còn nữa', true);
        return true;
      }
      this.target = { kind: 'window', hwnd, title: w.title, cls: w.cls };
      this.host.log(`remote màn hình: cửa sổ "${w.title}"`);
      if (w.minimized) void this.host.input.focus(hwnd);
    } else return true;
    this.host.refresh();
    this.host.broadcastStatus();
    return true;
  }
}
