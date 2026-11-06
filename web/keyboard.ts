// Bàn phím cho remote màn hình: hàng phím đặc biệt (Esc, Tab, mũi tên, Ctrl/Alt/Shift/Win giữ cho phím kế tiếp) và
// ô gõ chữ mở bàn phím của điện thoại. Chữ gõ vào (cả tiếng Việt có dấu) gửi sang máy bằng ký tự Unicode; xoá thì gửi
// Backspace. Bàn phím điện thoại hay sửa chữ đã gõ (gợi ý, ghép dấu), nên so ô gõ trước và sau mỗi lần đổi rồi gửi
// đúng phần khác: xoá bao nhiêu ký tự, thêm chữ gì.
import { $, send } from './core';
import { codeForChar } from '../shared/keys';

const panel = $('kbd');
const input = $<HTMLInputElement>('kbdInput');
const mods = new Set<string>();
// Ô gõ luôn có sẵn hai ký tự rỗng để phím xoá trên điện thoại vẫn có gì để xoá (ô trống thì không có sự kiện).
const BASE = '​​';
let prev = BASE;
let composing = false;

const key = (k: string, down: boolean) => send({ type: 'key', k, down });

/** Bấm một phím (kèm Ctrl/Alt/Shift/Win đang giữ), rồi thả các phím giữ. */
export function tap(code: string) {
  for (const m of mods) key(m, true);
  key(code, true);
  key(code, false);
  for (const m of mods) key(m, false);
  clearMods();
}

function clearMods() {
  mods.clear();
  for (const b of panel.querySelectorAll<HTMLElement>('[data-mod]')) b.classList.remove('on');
}

function typed(text: string) {
  if (!text) return;
  // Có Ctrl/Alt/Win: Ctrl+C phải là phím C thật, không phải chữ "c".
  if (mods.size && [...mods].some((m) => m !== 'ShiftLeft')) {
    for (const ch of text) {
      const code = codeForChar(ch);
      if (code) tap(code);
    }
    return;
  }
  clearMods();
  send({ type: 'text', s: text });
}

function onInput() {
  const cur = input.value;
  let i = 0;
  while (i < prev.length && i < cur.length && prev[i] === cur[i]) i++;
  for (let n = prev.length - i; n > 0; n--) tap('Backspace');
  typed(cur.slice(i).replace(/​/g, ''));
  prev = cur;
  if (!composing && (cur.length < 2 || cur.length > 40)) reset();
}

function reset() {
  input.value = prev = BASE;
  input.setSelectionRange(BASE.length, BASE.length);
}

export function initKeyboard() {
  reset();
  input.addEventListener('input', onInput);
  input.addEventListener('compositionstart', () => (composing = true));
  input.addEventListener('compositionend', () => {
    composing = false;
    onInput();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      tap('Enter');
      reset();
    }
  });
  input.addEventListener('blur', () => $('kbdType').classList.remove('on'));
  input.addEventListener('focus', () => $('kbdType').classList.add('on'));
  panel.addEventListener('pointerdown', (e) => {
    // Giữ bàn phím điện thoại mở khi bấm phím đặc biệt.
    if ((e.target as HTMLElement).closest('button') && document.activeElement === input) e.preventDefault();
  });
  panel.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    if (b.id === 'kbdType') {
      if (document.activeElement === input) input.blur();
      else input.focus();
      return;
    }
    if (b.dataset.mod) {
      const m = b.dataset.mod;
      if (mods.has(m)) mods.delete(m);
      else mods.add(m);
      b.classList.toggle('on', mods.has(m));
      return;
    }
    if (b.dataset.key) tap(b.dataset.key);
  });
}

export function showKeyboard(on: boolean) {
  panel.hidden = !on;
  document.body.classList.toggle('kbd-open', on);
  if (!on) {
    input.blur();
    clearMods();
  }
  dispatchEvent(new Event('resize'));
}
export const keyboardOpen = () => !panel.hidden;
