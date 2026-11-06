// Gửi phím và chuột bằng SendInput của Windows, giống hệt Chrome Remote Desktop
// (chromium remoting/host/input_injector_win.cc): KEYEVENTF_SCANCODE, wVk = 0, cờ EXTENDEDKEY cho phím mở rộng;
// chuột toạ độ tuyệt đối trên màn hình ảo (MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK); SetThreadExecutionState
// để PC không ngủ khi đang dùng từ xa. Không driver, không đụng tiến trình nào.
// Khác CRD đúng một chỗ: dwExtraInfo để 0 (CRD đóng dấu 'CRD0' để nhận ra phím của chính nó; mình không mạo danh CRD).
// Cửa sổ chạy quyền admin (nhiều game, công cụ hệ thống) chỉ nhận phím từ tiến trình quyền admin (UIPI): sidecar quyền thường gửi
// qua tiến trình phụ src/elevated.ts (xem bridge.ts). Mỗi lệnh là đúng một lần nhấn/nhả/di chuột do người làm.
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { KEYS } from '../../shared/keys';

const user32 = dlopen('user32.dll', {
  SetProcessDpiAwarenessContext: { args: [FFIType.i64], returns: FFIType.i32 },
  SendInput: { args: [FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
  SetForegroundWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  ShowWindow: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  IsIconic: { args: [FFIType.u64], returns: FFIType.i32 },
  GetForegroundWindow: { args: [], returns: FFIType.u64 },
  GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
});
const kernel32 = dlopen('kernel32.dll', {
  SetThreadExecutionState: { args: [FFIType.u32], returns: FFIType.u32 },
});
const u = user32.symbols;
u.SetProcessDpiAwarenessContext(-4n); // toạ độ chuột theo pixel thật, khớp với vùng chụp

const INPUT_SIZE = 40; // x64: type (4) + đệm (4) + union 32 byte
const ES_SYSTEM_REQUIRED = 0x1;
const KEYEVENTF_EXTENDEDKEY = 0x1;
const KEYEVENTF_KEYUP = 0x2;
const KEYEVENTF_UNICODE = 0x4;
const KEYEVENTF_SCANCODE = 0x8;
const MOUSEEVENTF_MOVE = 0x1;
const MOUSEEVENTF_WHEEL = 0x800;
const MOUSEEVENTF_HWHEEL = 0x1000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;

export type MouseAction = 'move' | 'down' | 'up' | 'rdown' | 'rup' | 'mdown' | 'mup' | 'wheel' | 'hwheel';
const BUTTON: Record<MouseAction, number> = {
  move: 0, down: 0x2, up: 0x4, rdown: 0x8, rup: 0x10, mdown: 0x20, mup: 0x40, wheel: MOUSEEVENTF_WHEEL, hwheel: MOUSEEVENTF_HWHEEL,
};
export const isMouseAction = (a: string): a is MouseAction => Object.hasOwn(BUTTON, a);
export const isKey = (code: string) => Object.hasOwn(KEYS, code);

function send(inputs: Uint8Array, count: number): boolean {
  kernel32.symbols.SetThreadExecutionState(ES_SYSTEM_REQUIRED);
  return u.SendInput(count, ptr(inputs), INPUT_SIZE) === count;
}

// KEYBDINPUT: wVk@8, wScan@10, dwFlags@12, time@16, dwExtraInfo@24.
export function sendKey(code: string, down: boolean): boolean {
  const k = KEYS[code];
  if (!k) return false;
  const buf = new Uint8Array(INPUT_SIZE);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 1, true); // INPUT_KEYBOARD
  dv.setUint16(10, k[0], true);
  dv.setUint32(12, KEYEVENTF_SCANCODE | (k[1] ? KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : KEYEVENTF_KEYUP), true);
  return send(buf, 1);
}

/** Gõ chữ (có dấu tiếng Việt, emoji) bằng KEYEVENTF_UNICODE: mỗi đơn vị UTF-16 một lần nhấn rồi nhả. */
export function sendText(s: string): boolean {
  const units = s;
  if (!units.length || units.length > 500) return false;
  const buf = new Uint8Array(INPUT_SIZE * units.length * 2);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < units.length; i++) {
    for (const up of [0, 1]) {
      const o = (i * 2 + up) * INPUT_SIZE;
      dv.setUint32(o, 1, true);
      dv.setUint16(o + 10, units.charCodeAt(i), true);
      dv.setUint32(o + 12, KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0), true);
    }
  }
  return send(buf, units.length * 2);
}

/** Chuột tới điểm (x, y) theo pixel thật của màn hình ảo, kèm nút hoặc cuộn (delta: 120 = một nấc). */
export function sendMouse(x: number, y: number, action: MouseAction, delta = 0): boolean {
  const m = u.GetSystemMetrics;
  const vx = m(76), vy = m(77), vw = m(78), vh = m(79); // SM_X/YVIRTUALSCREEN, SM_CX/CYVIRTUALSCREEN
  if (vw < 2 || vh < 2) return false;
  // MOUSEINPUT: dx@8, dy@12, mouseData@16, dwFlags@20, time@24, dwExtraInfo@32.
  const buf = new Uint8Array(INPUT_SIZE * 2);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0, true); // INPUT_MOUSE
  dv.setInt32(8, Math.round(((x - vx) * 65535) / (vw - 1)), true);
  dv.setInt32(12, Math.round(((y - vy) * 65535) / (vh - 1)), true);
  dv.setUint32(20, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, true);
  if (!BUTTON[action]) return send(buf.subarray(0, INPUT_SIZE), 1);
  dv.setUint32(INPUT_SIZE, 0, true);
  if (action === 'wheel' || action === 'hwheel') dv.setInt32(INPUT_SIZE + 16, Math.max(-2400, Math.min(2400, Math.round(delta))), true);
  dv.setUint32(INPUT_SIZE + 20, BUTTON[action], true);
  return send(buf, 2);
}

/**
 * Đưa cửa sổ lên trên cùng (như bấm vào nó trên taskbar); đang thu nhỏ thì mở lại.
 * Windows chỉ cho tiến trình vừa nhận thao tác của người dùng giành focus. Không được thì giữ phím Alt trong lúc
 * gọi SetForegroundWindow (mẹo quen thuộc, nhiều phần mềm điều khiển từ xa dùng): phím đi qua SendInput nên mình
 * là "tiến trình vừa có thao tác". Nhả Alt sau khi đổi focus nên không bật menu của cửa sổ nào.
 */
export function focusWindow(hwnd: bigint): boolean {
  if (u.IsIconic(hwnd)) u.ShowWindow(hwnd, 9); // SW_RESTORE
  if (u.SetForegroundWindow(hwnd) && BigInt(u.GetForegroundWindow()) === hwnd) return true;
  sendKey('AltLeft', true);
  const ok = !!u.SetForegroundWindow(hwnd);
  sendKey('AltLeft', false);
  return ok && BigInt(u.GetForegroundWindow()) === hwnd;
}
