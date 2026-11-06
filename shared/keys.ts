// Bảng phím: tên theo KeyboardEvent.code → [scancode set 1, phím mở rộng]. Dùng chung cho sidecar (gửi phím) và
// trang web (chọn phím cho nút, bàn phím ảo). Chỉ phím trong bảng này mới gửi được.
export const KEYS: Record<string, [number, boolean]> = {
  Escape: [0x01, false],
  Digit1: [0x02, false], Digit2: [0x03, false], Digit3: [0x04, false], Digit4: [0x05, false], Digit5: [0x06, false],
  Digit6: [0x07, false], Digit7: [0x08, false], Digit8: [0x09, false], Digit9: [0x0a, false], Digit0: [0x0b, false],
  Minus: [0x0c, false], Equal: [0x0d, false], Backspace: [0x0e, false], Tab: [0x0f, false],
  KeyQ: [0x10, false], KeyW: [0x11, false], KeyE: [0x12, false], KeyR: [0x13, false], KeyT: [0x14, false],
  KeyY: [0x15, false], KeyU: [0x16, false], KeyI: [0x17, false], KeyO: [0x18, false], KeyP: [0x19, false],
  BracketLeft: [0x1a, false], BracketRight: [0x1b, false], Enter: [0x1c, false], ControlLeft: [0x1d, false],
  KeyA: [0x1e, false], KeyS: [0x1f, false], KeyD: [0x20, false], KeyF: [0x21, false], KeyG: [0x22, false],
  KeyH: [0x23, false], KeyJ: [0x24, false], KeyK: [0x25, false], KeyL: [0x26, false], Semicolon: [0x27, false],
  Quote: [0x28, false], Backquote: [0x29, false], ShiftLeft: [0x2a, false], Backslash: [0x2b, false],
  KeyZ: [0x2c, false], KeyX: [0x2d, false], KeyC: [0x2e, false], KeyV: [0x2f, false], KeyB: [0x30, false],
  KeyN: [0x31, false], KeyM: [0x32, false], Comma: [0x33, false], Period: [0x34, false], Slash: [0x35, false],
  ShiftRight: [0x36, false], AltLeft: [0x38, false], Space: [0x39, false],
  F1: [0x3b, false], F2: [0x3c, false], F3: [0x3d, false], F4: [0x3e, false], F5: [0x3f, false], F6: [0x40, false],
  F7: [0x41, false], F8: [0x42, false], F9: [0x43, false], F10: [0x44, false], F11: [0x57, false], F12: [0x58, false],
  ControlRight: [0x1d, true], AltRight: [0x38, true],
  Insert: [0x52, true], Delete: [0x53, true], Home: [0x47, true], End: [0x4f, true], PageUp: [0x49, true], PageDown: [0x51, true],
  ArrowUp: [0x48, true], ArrowDown: [0x50, true], ArrowLeft: [0x4b, true], ArrowRight: [0x4d, true],
  CapsLock: [0x3a, false], MetaLeft: [0x5b, true], MetaRight: [0x5c, true], ContextMenu: [0x5d, true],
};

/** Tên ngắn hiện trên nút khi chưa đặt nhãn. */
export function keyLabel(code: string): string {
  const short: Record<string, string> = {
    Escape: 'Esc', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt', ShiftLeft: 'Shift',
    ShiftRight: 'Shift', MetaLeft: 'Win', MetaRight: 'Win', ContextMenu: 'Menu', CapsLock: 'Caps', PageUp: 'PgUp', PageDown: 'PgDn', Delete: 'Del', Insert: 'Ins', Backspace: '⌫',
    ArrowUp: '▲', ArrowDown: '▼', ArrowLeft: '◀', ArrowRight: '▶', Minus: '-', Equal: '=', BracketLeft: '[',
    BracketRight: ']', Semicolon: ';', Quote: "'", Backquote: '`', Backslash: '\\', Comma: ',', Period: '.', Slash: '/',
  };
  return short[code] ?? code.replace(/^Key|^Digit/, '');
}

/** Ký tự gõ kèm Ctrl/Alt/Win (vd Ctrl+C) phải gửi bằng phím thật, không gửi bằng ký tự Unicode. */
export function codeForChar(ch: string): string | null {
  const c = ch.toLowerCase();
  if (c >= 'a' && c <= 'z') return `Key${c.toUpperCase()}`;
  if (c >= '0' && c <= '9') return `Digit${c}`;
  const map: Record<string, string> = {
    ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', ';': 'Semicolon', "'": 'Quote',
    '`': 'Backquote', '\\': 'Backslash', ',': 'Comma', '.': 'Period', '/': 'Slash',
  };
  return map[c] ?? null;
}
