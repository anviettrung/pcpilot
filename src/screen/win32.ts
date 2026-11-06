// Thông tin cửa sổ và màn hình qua user32 (như taskbar): chỉ đọc, không mở tiến trình nào, không gửi thông điệp
// nào tới cửa sổ. Dùng cho remote màn hình (chọn màn hình, chọn cửa sổ) và các app chụp theo cửa sổ (WindowApp).
import { dlopen, FFIType, JSCallback, ptr } from 'bun:ffi';

const user32 = dlopen('user32.dll', {
  SetProcessDpiAwarenessContext: { args: [FFIType.i64], returns: FFIType.i32 },
  FindWindowExW: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
  IsWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  IsWindowVisible: { args: [FFIType.u64], returns: FFIType.i32 },
  IsIconic: { args: [FFIType.u64], returns: FFIType.i32 },
  GetClientRect: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  ClientToScreen: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  MonitorFromWindow: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u64 },
  GetMonitorInfoW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  EnumDisplayMonitors: { args: [FFIType.u64, FFIType.ptr, FFIType.function, FFIType.i64], returns: FFIType.i32 },
  GetForegroundWindow: { args: [], returns: FFIType.u64 },
  GetAncestor: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u64 },
  GetWindow: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u64 },
  GetWindowTextW: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  GetClassNameW: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  GetWindowLongPtrW: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i64 },
});
const dwm = dlopen('dwmapi.dll', {
  DwmGetWindowAttribute: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
});
const u = user32.symbols;

// Toạ độ thật theo pixel màn hình (không bị Windows co giãn theo DPI). -4 = PER_MONITOR_AWARE_V2.
u.SetProcessDpiAwarenessContext(-4n);

const wstr = (s: string) => Buffer.from(s + '\0', 'utf16le');

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Monitor extends Rect {
  primary: boolean;
  /** Tên GDI của màn hình (vd DISPLAY1 kèm tiền tố \\.\): dùng để xoay, đổi cỡ chữ (src/screen/display.ts). */
  device: string;
}

/** MONITORINFOEXW: cbSize, rcMonitor(4), rcWork(4), dwFlags, szDevice[32] = 104 byte. */
function monitorInfo(hmon: bigint): Monitor {
  const mi = new Int32Array(26);
  mi[0] = 104;
  u.GetMonitorInfoW(hmon, ptr(mi));
  const device = Buffer.from(mi.buffer, 40, 64).toString('utf16le').split(String.fromCharCode(0))[0];
  return { x: mi[1], y: mi[2], w: mi[3] - mi[1], h: mi[4] - mi[2], primary: (mi[9] & 1) === 1, device };
}

export interface WindowInfo extends Rect {
  hwnd: bigint;
  title: string;
  cls: string;
  minimized: boolean;
  foreground: boolean;
  /** Màn hình chứa cửa sổ, theo toạ độ màn hình ảo. */
  monitor: Monitor;
}

function text(fn: (h: bigint, p: any, n: number) => number, h: bigint): string {
  const buf = new Uint16Array(256);
  const n = fn(h, ptr(buf), buf.length);
  return String.fromCharCode(...buf.subarray(0, Math.max(0, n)));
}
export const windowTitle = (h: bigint) => text(u.GetWindowTextW, h);
export const windowClass = (h: bigint) => text(u.GetClassNameW, h);

function monitorOf(hwnd: bigint): Monitor {
  return monitorInfo(BigInt(u.MonitorFromWindow(hwnd, 2))); // MONITOR_DEFAULTTONEAREST
}

/** Mọi màn hình theo toạ độ màn hình ảo, màn hình chính trước. */
export function listMonitors(): Monitor[] {
  const out: Monitor[] = [];
  const cb = new JSCallback(
    (hmon: bigint) => {
      out.push(monitorInfo(BigInt(hmon)));
      return 1;
    },
    { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
  );
  try {
    u.EnumDisplayMonitors(0n, null, cb.ptr, 0n);
  } finally {
    cb.close();
  }
  return out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.x - b.x || a.y - b.y);
}

/** Vùng client (không viền, không thanh tiêu đề) của cửa sổ, theo toạ độ màn hình ảo. */
export function windowInfo(hwnd: bigint): WindowInfo | null {
  if (!hwnd || !u.IsWindow(hwnd)) return null;
  const rc = new Int32Array(4);
  const pt = new Int32Array(2);
  if (!u.GetClientRect(hwnd, ptr(rc)) || !u.ClientToScreen(hwnd, ptr(pt))) return null;
  return {
    hwnd,
    title: windowTitle(hwnd),
    cls: windowClass(hwnd),
    minimized: !!u.IsIconic(hwnd),
    foreground: isForeground(hwnd),
    x: pt[0],
    y: pt[1],
    w: rc[2],
    h: rc[3],
    monitor: monitorOf(hwnd),
  };
}

function* topWindows(cls: string | null = null): Generator<bigint> {
  const c = cls ? wstr(cls) : null;
  for (let h = BigInt(u.FindWindowExW(0n, 0n, c, null)); h; h = BigInt(u.FindWindowExW(0n, h, c, null))) yield h;
}

/** Cửa sổ lớn nhất có lớp này (game hay có nhiều cửa sổ cùng lớp, vd khung chat tách rời). */
export function findWindowByClass(cls: string, title?: RegExp): WindowInfo | null {
  const rc = new Int32Array(4);
  let best = 0;
  let hwnd = 0n;
  for (const h of topWindows(cls)) {
    if (!u.IsWindowVisible(h) || !u.GetClientRect(h, ptr(rc))) continue;
    if (title && !title.test(windowTitle(h))) continue;
    const area = rc[2] * rc[3];
    if (area > best) [best, hwnd] = [area, h];
  }
  return hwnd ? windowInfo(hwnd) : null;
}

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80;
const GW_OWNER = 4;
const DWMWA_CLOAKED = 14;

/** Cửa sổ ứng dụng đang mở (như thanh taskbar): hiện, có tiêu đề, không phải cửa sổ công cụ hay cửa sổ con. */
export function listWindows(): { hwnd: string; title: string; cls: string; w: number; h: number; minimized: boolean }[] {
  const out: { hwnd: string; title: string; cls: string; w: number; h: number; minimized: boolean }[] = [];
  const rc = new Int32Array(4);
  const cloaked = new Int32Array(1);
  for (const h of topWindows()) {
    if (!u.IsWindowVisible(h) || BigInt(u.GetWindow(h, GW_OWNER))) continue;
    if (Number(u.GetWindowLongPtrW(h, GWL_EXSTYLE)) & WS_EX_TOOLWINDOW) continue;
    cloaked[0] = 0;
    dwm.symbols.DwmGetWindowAttribute(h, DWMWA_CLOAKED, ptr(cloaked), 4);
    if (cloaked[0]) continue; // app UWP đang ẩn, cửa sổ trên desktop ảo khác
    const title = windowTitle(h);
    if (!title) continue;
    const cls = windowClass(h);
    if (cls === 'Progman' || cls === 'Shell_TrayWnd') continue;
    const minimized = !!u.IsIconic(h);
    u.GetClientRect(h, ptr(rc));
    if (!minimized && (rc[2] < 120 || rc[3] < 80)) continue;
    out.push({ hwnd: String(h), title, cls, w: rc[2], h: rc[3], minimized });
  }
  return out;
}

/** Cửa sổ trên cùng có phải cửa sổ này (hoặc cửa sổ cùng lớp, nếu đưa lớp) không. */
export function isForeground(hwnd: bigint, sameClass?: string): boolean {
  const f = BigInt(u.GetForegroundWindow());
  if (!f) return false;
  if (f === hwnd || BigInt(u.GetAncestor(f, 3)) === hwnd) return true; // GA_ROOTOWNER: hộp thoại của chính nó
  return !!sameClass && windowClass(f) === sameClass;
}
