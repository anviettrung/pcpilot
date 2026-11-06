// Giao diện chung cho app chụp màn hình (remote màn hình, app mới theo cửa sổ như game): chạm thành chuột
// (web/pointer.ts), bàn phím (web/keyboard.ts), bàn phím ảo sửa được (web/pad.ts), nút đưa cửa sổ lên trên, phóng to.
// Mỗi app khai riêng: mặc định có bật chế độ chuột không, bố cục bàn phím ảo mặc định, câu báo khi chưa chụp được.
import { $, S, applyZoom, esc, prefs, savePrefs, send, toast, zoom, type Overlay, type WebApp } from '../core';
import { initKeyboard, keyboardOpen, showKeyboard } from '../keyboard';
import { Pad, type Control, type Layout } from '../pad';
import { releasePointer, pointerState, screenPointer } from '../pointer';
import { KEYS, keyLabel } from '../../shared/keys';

export interface ScreenSpec {
  id: string;
  icon: string;
  section?: string;
  /** Chạm vào hình là click chuột ngay từ đầu (remote màn hình: có; game có bàn phím ảo: không). */
  mouse: boolean;
  /** Nút ở góc hình đổi qua lại giữa bàn phím ảo và chạm = click (bật chuột thì ẩn bàn phím ảo), thay nút 🖱 trên thanh. */
  modeToggle?: boolean;
  /** Có nút chế độ điện thoại (xoay màn hình máy, tăng cỡ chữ) trên thanh. */
  mobile?: boolean;
  /** App chơi ngang (game): khoá ngang khi được (Android PWA), cầm dọc thì hiện nhắc xoay ngang (iPhone không khoá được). */
  landscape?: boolean;
  pad?: () => Layout;
  /** Câu báo theo mã lý do chưa chụp được (status.stream.reason). {m} = tên máy. */
  reasons: Record<string, [string, string] | [string, string, string]>;
  label?(a: any): string;
  info?(a: any): string;
  sheet?(st: any, a: any): void;
  onJson?: WebApp['onJson'];
  init?(): void;
  /** Lớp phủ riêng, xét trước câu báo theo mã lý do (undefined = để câu báo chung). */
  overlay?(st: any, a: any): Overlay | null | undefined;
  enter?(on: boolean): void;
  render?(st: any, a: any): void;
}

// Dùng chung một bàn phím ảo và một bảng sửa cho mọi app màn hình; mỗi app nạp bố cục của nó khi được xem.
const pad = new Pad($('pad'), (code, down) => send({ type: 'key', k: code, down }));
let shared = false;
let activeId = '';
let activeToggle = false;

const ICON_PAD =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 11v3M5.5 12.5h3M15.5 12h.01M18 14h.01"/></svg>';
const ICON_PRESETS =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5z"/><path d="m3 13 9 5 9-5"/></svg>';
const ICON_MOUSE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/></svg>';

function initShared() {
  if (shared) return;
  shared = true;
  initKeyboard();
  const editBtn = $('editBtn');
  const editBar = $('editBar');
  const ed = $('ctlEditor');
  const edKey = $<HTMLSelectElement>('edKey');
  const edLabel = $<HTMLInputElement>('edLabel');
  const edTarget = $<HTMLSelectElement>('edTarget');
  // Nút giữ được phép không gửi phím nào (chỉ đổi bố cục): lựa chọn đầu "(không)".
  edKey.innerHTML = '<option value="">(không phím)</option>' + Object.keys(KEYS)
    .map((code) => `<option value="${code}">${keyLabel(code)}${keyLabel(code) === code ? '' : ` (${code})`}</option>`)
    .join('');
  let editing: Control | null = null;
  const setEdit = (on: boolean) => {
    if (on && keyboardOpen()) showKeyboard(false);
    pad.setEditing(on);
    editBar.hidden = !on;
    editBtn.classList.toggle('active', on);
    paintPresets();
  };

  // Thanh sửa ở trên hay dưới: nút cần dời nằm dưới thanh thì đổi chỗ thanh.
  const dock = $('editDock');
  const posBtn = $('editBarPos');
  const paintDock = () => {
    const bottom = !!prefs.editBarBottom;
    dock.classList.toggle('bottom', bottom);
    posBtn.textContent = bottom ? '↑ Lên trên' : '↓ Xuống dưới';
    posBtn.setAttribute('aria-label', bottom ? 'Dời thanh lên trên' : 'Dời thanh xuống dưới');
  };
  posBtn.onclick = () => {
    prefs.editBarBottom = !prefs.editBarBottom;
    savePrefs();
    paintDock();
  };
  paintDock();

  // Bố cục (preset): chọn, thêm (chép từ bố cục đang dùng), đổi tên, xoá.
  const sel = $<HTMLSelectElement>('presetSel');
  sel.onchange = () => pad.usePreset(sel.value);
  $('presetNew').onclick = () => {
    const name = prompt('Tên bố cục mới (chép từ bố cục đang dùng):', pad.nextPresetName())?.trim();
    if (name) pad.addPreset(name.slice(0, 24));
  };
  $('presetRename').onclick = () => {
    const cur = pad.current();
    const name = cur && prompt('Tên bố cục:', cur.name)?.trim();
    if (name) pad.renamePreset(name.slice(0, 24));
  };
  $('presetDelete').onclick = () => {
    const cur = pad.current();
    if (cur && pad.presets.length > 1 && confirm(`Xoá bố cục "${cur.name}"?`)) pad.deletePreset();
  };
  // Đổi nhanh khi đang chơi: nút ở góc trên trái, chạm mở danh sách, chạm tên để đổi.
  const menu = $('presetMenu');
  $('presetBtn').onclick = () => {
    menu.hidden = !menu.hidden;
    if (!menu.hidden) paintPresets();
  };
  menu.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (!b) return;
    menu.hidden = true;
    pad.usePreset(b.dataset.id!);
    toast(`Bố cục: ${pad.current()?.name ?? ''}`);
  });
  addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !(e.target as HTMLElement).closest('#presetMenu, #presetBtn')) menu.hidden = true;
  });
  pad.onPresets = paintPresets;
  editBtn.onclick = () => {
    // Đang ở chế độ click (bàn phím ảo ẩn) mà bấm sửa: về chế độ bàn phím ảo trước.
    if (activeToggle && pointerState.mouse) {
      pointerState.mouse = false;
      prefs.mouse = { ...prefs.mouse, [activeId]: false };
      savePrefs();
      paintMouse();
    }
    setEdit(!pad.editing);
  };
  $('doneEdit').onclick = () => setEdit(false);
  $('addKey').onclick = () => pad.add('key');
  $('addDpad').onclick = () => pad.add('dpad');
  $('addLayer').onclick = () => pad.add('layer');
  $('resetLayout').onclick = () => confirm('Đưa bố cục nút về mặc định?') && pad.reset();
  pad.onSelect = (c) => {
    editing = c;
    ed.hidden = !c;
    if (!c) return;
    edKey.parentElement!.hidden = edLabel.parentElement!.hidden = c.type === 'dpad';
    edTarget.parentElement!.hidden = c.type !== 'layer';
    edKey.value = c.key ?? '';
    edLabel.value = c.label ?? '';
    if (c.type === 'layer') {
      const cur = pad.current();
      const others = pad.presets.filter((p) => p.id !== cur?.id);
      edTarget.innerHTML =
        '<option value="">(chưa chọn)</option>' +
        others.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') +
        '<option value="__new">+ Bố cục trống mới…</option>';
      edTarget.value = others.some((p) => p.id === c.target) ? c.target! : '';
    }
    ed.querySelectorAll<HTMLElement>('#edSize [data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === c.size));
  };
  edKey.onchange = () => {
    if (!editing) return;
    // Nút phím thường phải có phím.
    if (!edKey.value && editing.type === 'key') return void (edKey.value = editing.key ?? '');
    editing.key = edKey.value || undefined;
    pad.update(editing);
  };
  edTarget.onchange = () => {
    if (!editing) return;
    if (edTarget.value === '__new') {
      const def = `Giữ ${editing.label || (editing.key ? keyLabel(editing.key) : '')}`.trim();
      const name = prompt('Tên bố cục hiện khi giữ (trống, sửa bằng ô chọn bố cục):', def)?.trim();
      if (!name) return void (edTarget.value = editing.target ?? '');
      editing.target = pad.addPreset(name.slice(0, 24), { empty: true, use: false });
      toast(`Đã tạo "${name}". Chọn nó ở ô bố cục để xếp nút.`);
    } else editing.target = edTarget.value || undefined;
    pad.update(editing);
  };
  edLabel.onchange = () => {
    if (!editing) return;
    editing.label = edLabel.value.trim() || undefined;
    pad.update(editing);
  };
  ed.querySelectorAll<HTMLElement>('#edSize [data-v]').forEach(
    (b) =>
      (b.onclick = () => {
        if (!editing) return;
        editing.size = b.dataset.v as Control['size'];
        pad.update(editing);
      }),
  );
  $('edDelete').onclick = () => editing && pad.remove(editing);
  // Chạm ra ngoài nút khi đang sửa: bỏ chọn.
  $('stage').addEventListener('pointerdown', (e) => {
    if (pad.editing && !(e.target as HTMLElement).closest('.ctl, #ctlEditor, #editBar')) pad.select(null);
  });

  const toggleMouse = () => {
    if (pad.editing) setEdit(false);
    releasePointer();
    pointerState.mouse = !pointerState.mouse;
    prefs.mouse = { ...prefs.mouse, [activeId]: pointerState.mouse };
    savePrefs();
    paintMouse();
    if (activeToggle)
      toast(pointerState.mouse ? 'Chế độ click: chạm vào hình để click chuột' : 'Chế độ bàn phím ảo: chạm vào hình không click');
    else toast(pointerState.mouse ? 'Chạm vào hình để click chuột' : 'Đã tắt chuột: chạm vào hình không click');
  };
  $('mouseBtn').onclick = toggleMouse;
  $('modeBtn').onclick = toggleMouse;
  $('kbdBtn').onclick = () => {
    if (pad.editing) setEdit(false);
    showKeyboard(!keyboardOpen());
    $('kbdBtn').classList.toggle('active', keyboardOpen());
  };
  $('zoomBtn').onclick = () => {
    zoom.k = 1;
    applyZoom();
  };
  $('focusBtn').onclick = () => send({ type: 'focus' });
}

function paintPresets() {
  const all = pad.presets;
  const cur = pad.current();
  // Bố cục làm lớp của nút giữ chỉ hiện khi giữ: không đưa vào danh sách đổi nhanh (ô chọn khi sửa vẫn có).
  const layers = new Set(all.flatMap((p) => p.layout.controls.filter((c) => c.type === 'layer' && c.target).map((c) => c.target!)));
  const list = all.filter((p) => !layers.has(p.id) || p.id === cur?.id);
  const sel = $<HTMLSelectElement>('presetSel');
  sel.innerHTML = all.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${layers.has(p.id) ? ' (giữ)' : ''}</option>`).join('');
  if (cur) sel.value = cur.id;
  $<HTMLButtonElement>('presetDelete').disabled = all.length < 2;
  // Nút đổi nhanh: chỉ khi có từ 2 bố cục, bàn phím ảo đang hiện và không sửa.
  const btn = $('presetBtn');
  const menu = $('presetMenu');
  btn.hidden = list.length < 2 || pad.editing || $('pad').hidden;
  if (btn.hidden) menu.hidden = true;
  btn.innerHTML = `${ICON_PRESETS}<span>${esc(cur?.name ?? '')}</span>`;
  btn.setAttribute('aria-label', `Bố cục nút: ${cur?.name ?? ''}. Bấm để đổi`);
  menu.innerHTML = list
    .map((p) => `<button type="button" role="menuitem" data-id="${esc(p.id)}"${p.id === cur?.id ? ' class="on"' : ''}>${esc(p.name)}</button>`)
    .join('');
}

function paintMouse() {
  const m = pointerState.mouse;
  $('mouseBtn').classList.toggle('active', m);
  $('video').classList.toggle('mouse', m);
  $('mouseBtn').hidden = activeToggle;
  const btn = $('modeBtn');
  btn.hidden = !activeToggle;
  if (!activeToggle) return paintPresets();
  // Chế độ click thì ẩn bàn phím ảo (nhả phím đang giữ) để chạm chỗ nào trên hình cũng click được.
  if (m) pad.releaseAll();
  $('pad').hidden = m;
  btn.classList.toggle('mouse', m);
  btn.innerHTML = m ? `${ICON_MOUSE}<span>Click</span>` : `${ICON_PAD}<span>Nút</span>`;
  btn.setAttribute('aria-label', m ? 'Đang ở chế độ click. Bấm để về bàn phím ảo' : 'Đang ở chế độ bàn phím ảo. Bấm để chuyển sang click');
  paintPresets();
}

// Khoá ngang: Android (PWA, toàn màn hình) khoá được hướng màn hình; iPhone thì không (Safari không cho), nên cầm
// dọc thì hiện nhắc xoay ngang.
const isPortrait = () => innerHeight > innerWidth;
function lockLandscape(on: boolean) {
  const o: any = screen.orientation;
  if (!o) return;
  if (on) o.lock?.('landscape').catch(() => {});
  else o.unlock?.();
}

export function screenApp(spec: ScreenSpec): WebApp {
  return {
    id: spec.id,
    group: 'screen',
    section: spec.section,
    icon: spec.icon,
    init() {
      initShared();
      spec.init?.();
    },
    enter(on) {
      spec.enter?.(on);
      if (spec.landscape) lockLandscape(on);
      if (!on) {
        $('rotateHint').hidden = true;
        releasePointer();
        pad.load('', () => ({ v: 1, controls: [] }));
        $('editBar').hidden = $('ctlEditor').hidden = true;
        $('editBtn').classList.remove('active');
        showKeyboard(false);
        $('kbdBtn').classList.remove('active');
        activeToggle = false;
        $('pad').hidden = false;
        paintMouse();
        return;
      }
      activeId = spec.id;
      activeToggle = !!spec.modeToggle;
      pointerState.mouse = prefs.mouse?.[spec.id] ?? spec.mouse;
      paintMouse();
      pad.load(spec.id, spec.pad ?? (() => ({ v: 1, controls: [] })));
    },
    overlay(st, a): Overlay | null {
      const own = spec.overlay?.(st, a);
      if (own !== undefined) return own;
      const r = spec.reasons[st.stream?.reason];
      if (!r) return null;
      return { title: r[0], text: r[1].replace('{m}', st.machine), pick: r[2] };
    },
    render(st, a) {
      spec.render?.(st, a);
      if (spec.landscape) $('rotateHint').hidden = !isPortrait() || !a.w;
      const s = st?.stream;
      $('focusBtn').hidden = !s || !s.window || s.foreground || !s.capturing;
      $('zoomBtn').hidden = zoom.k <= 1;
      $('mobileBtn').hidden = !spec.mobile;
      $('mobileBtn').classList.toggle('active', !!spec.mobile && prefs.mobile.on);
      $('zoomBtn').textContent = `${zoom.k.toFixed(1)}× · 1×`;
    },
    label: spec.label,
    info: spec.info,
    sheet: spec.sheet,
    onJson: spec.onJson,
    pointer: screenPointer,
    releaseAll() {
      pad.releaseAll();
      releasePointer();
    },
    metrics: (st) => [['Thao tác đã gửi', String(st.stream.inputs)]],
  };
}

export const viewing = (id: string) => S.view?.status?.app === id;
