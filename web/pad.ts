// Bàn phím ảo: D-pad + các nút phím, đặt chồng lên hình (game, app). Mỗi app có nhiều bố cục (preset) đổi qua lại
// nhanh, sửa được ngay trên điện thoại (kéo thả, đổi phím, nhãn, cỡ), lưu trong localStorage của điện thoại đó.
// Nguyên tắc: chạm = nhấn, thả = nhả. Không lặp, không bấm hộ, không nút khoá giữ.
// Nút giữ (type 'layer'): giữ thì nhấn phím của nó (nếu có, vd F11) và hiện một bố cục khác chồng lên (vd 1..5) để ngón
// khác bấm tổ hợp F11+1; thả thì nhả phím, về bố cục cũ. Bố cục hiện khi giữ là một preset bình thường.
import { KEYS, keyLabel } from '../shared/keys';

export type Size = 's' | 'm' | 'l';
export interface Control {
  id: string;
  type: 'key' | 'dpad' | 'layer';
  /** Nút phím: phím gửi. Nút giữ: phím nhấn trong lúc giữ (không có = chỉ đổi bố cục). */
  key?: string;
  label?: string;
  /** Nút giữ: id preset hiện ra khi giữ. */
  target?: string;
  /** Tâm nút, theo tỉ lệ khung sân khấu (0..1). */
  x: number;
  y: number;
  size: Size;
}
export interface Layout {
  v: 1;
  controls: Control[];
}

const PX: Record<Size, number> = { s: 48, m: 62, l: 80 };
const DPAD_PX: Record<Size, number> = { s: 130, m: 160, l: 196 };

let n = 0;
const id = () => `c${Date.now().toString(36)}${(n++).toString(36)}`;
export const k = (key: string, x: number, y: number, size: Size = 'm', label?: string): Control => ({ id: id(), type: 'key', key, label, x, y, size });
export const dpad = (x: number, y: number, size: Size = 'm'): Control => ({ id: id(), type: 'dpad', x, y, size });

export interface Preset {
  id: string;
  name: string;
  layout: Layout;
}
interface Store {
  v: 2;
  active: string;
  presets: Preset[];
}

const STORE = (app: string) => `pcpilot:pads:${app}`;
/** Bản cũ (một bố cục mỗi app): đọc một lần để chuyển thành preset đầu tiên. */
const OLD_STORE = (app: string) => `pcpilot:pad:${app}`;
const isLayout = (l: any): l is Layout => l?.v === 1 && Array.isArray(l.controls);

function loadStore(app: string, defaults: () => Layout): Store {
  try {
    const st = JSON.parse(localStorage.getItem(STORE(app)) ?? '');
    if (st?.v === 2 && Array.isArray(st.presets)) {
      const presets = st.presets.filter((p: any) => p && typeof p.id === 'string' && isLayout(p.layout));
      if (presets.length) return { v: 2, active: presets.some((p: Preset) => p.id === st.active) ? st.active : presets[0].id, presets };
    }
  } catch {}
  let layout = defaults();
  try {
    const l = JSON.parse(localStorage.getItem(OLD_STORE(app)) ?? '');
    if (isLayout(l)) layout = l;
  } catch {}
  const first: Preset = { id: id(), name: 'Bố cục 1', layout };
  return { v: 2, active: first.id, presets: [first] };
}

/** Chữ trên nút: nhãn, không thì tên phím, nút giữ không phím thì "Giữ". */
export const ctlText = (c: Control) => c.label || (c.key ? keyLabel(c.key) : c.type === 'layer' ? 'Giữ' : '');

type SendKey = (code: string, down: boolean) => void;

export class Pad {
  layout: Layout = { v: 1, controls: [] };
  editing = false;
  private store: Store | null = null;
  private app = '';
  private defaults: () => Layout = () => ({ v: 1, controls: [] });
  private els = new Map<string, HTMLElement>();
  /** pointerId → các phím đang giữ bởi ngón đó. */
  private held = new Map<number, { ctl: Control; keys: Set<string> }>();
  private selected: string | null = null;
  /** Nút giữ đang giữ và các nút của bố cục đang hiện chồng lên. */
  private layer: { pid: number; holder: Control; ctls: Control[] } | null = null;
  /** Phần tử ngoài bố cục chính (nút của lớp giữ, bóng nút giữ khi sửa), place() đặt chỗ cùng lúc. */
  private extra = new Map<HTMLElement, Control>();
  onSelect: (c: Control | null) => void = () => {};
  /** Đổi preset, thêm, xoá, đổi tên: để giao diện vẽ lại danh sách preset. */
  onPresets: () => void = () => {};

  constructor(private root: HTMLElement, private sendKey: SendKey) {
    addEventListener('resize', () => this.place());
  }

  /** Bố cục của app (rỗng = ẩn bàn phím ảo). */
  load(app: string, defaults: () => Layout) {
    this.releaseAll();
    this.app = app;
    this.defaults = defaults;
    this.store = app ? loadStore(app, defaults) : null;
    this.layout = this.current()?.layout ?? { v: 1, controls: [] };
    this.editing = false;
    this.selected = null;
    this.render();
    this.onPresets();
  }

  private save() {
    if (this.app && this.store) localStorage.setItem(STORE(this.app), JSON.stringify(this.store));
  }

  // --- Preset -----------------------------------------------------------------------------------
  get presets(): readonly Preset[] {
    return this.store?.presets ?? [];
  }

  current(): Preset | undefined {
    return this.store?.presets.find((p) => p.id === this.store!.active);
  }

  /** Đổi sang preset khác: nhả phím đang giữ, giữ nguyên chế độ sửa. */
  usePreset(pid: string) {
    const p = this.store?.presets.find((x) => x.id === pid);
    if (!p || p.id === this.store!.active) return;
    this.releaseAll();
    this.store!.active = p.id;
    this.layout = p.layout;
    this.save();
    this.select(null);
    this.render();
    this.onPresets();
  }

  /** Preset mới: mặc định chép từ preset đang dùng rồi chuyển sang nó; empty = bố cục trống, use: false = ở lại. */
  addPreset(name: string, opt: { empty?: boolean; use?: boolean } = {}): string | undefined {
    if (!this.store) return;
    const layout: Layout = { v: 1, controls: opt.empty ? [] : this.layout.controls.map((c) => ({ ...c, id: id() })) };
    const p: Preset = { id: id(), name, layout };
    this.store.presets.push(p);
    this.save();
    if (opt.use === false) this.onPresets();
    else this.usePreset(p.id);
    return p.id;
  }

  renamePreset(name: string) {
    const p = this.current();
    if (!p) return;
    p.name = name;
    this.save();
    this.onPresets();
  }

  /** Xoá preset đang dùng, chuyển sang preset kề nó. Không xoá preset cuối cùng. */
  deletePreset() {
    const st = this.store;
    if (!st || st.presets.length < 2) return;
    const i = st.presets.findIndex((p) => p.id === st.active);
    st.presets.splice(i, 1);
    const next = st.presets[Math.min(i, st.presets.length - 1)];
    this.releaseAll();
    st.active = next.id;
    this.layout = next.layout;
    this.save();
    this.select(null);
    this.render();
    this.onPresets();
  }

  /** Tên gợi ý cho preset mới: "Bố cục N" chưa ai dùng. */
  nextPresetName() {
    const names = new Set(this.presets.map((p) => p.name));
    let i = this.presets.length + 1;
    while (names.has(`Bố cục ${i}`)) i++;
    return `Bố cục ${i}`;
  }

  private makeEl(c: Control): HTMLElement {
    const el = document.createElement('div');
    el.className = `ctl ${c.type} size-${c.size}`;
    el.dataset.id = c.id;
    if (c.type === 'dpad') {
      el.innerHTML = '<span class="ar u">▲</span><span class="ar d">▼</span><span class="ar l">◀</span><span class="ar r">▶</span><span class="knob"></span>';
    } else {
      const text = ctlText(c);
      el.textContent = text;
      if (text.length > 4) el.classList.add('long');
    }
    el.addEventListener('pointerdown', (e) => this.down(e, c, el));
    el.addEventListener('pointermove', (e) => this.move(e, c, el));
    el.addEventListener('pointerup', (e) => this.up(e, c, el));
    el.addEventListener('pointercancel', (e) => this.up(e, c, el));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    return el;
  }

  render() {
    this.releaseAll();
    this.root.replaceChildren();
    this.els.clear();
    this.extra.clear();
    for (const c of this.layout.controls) {
      const el = this.makeEl(c);
      this.root.append(el);
      this.els.set(c.id, el);
    }
    // Đang sửa một bố cục là lớp của nút giữ nào đó: hiện bóng nút giữ để biết ngón giữ nằm đâu, khỏi xếp nút đè lên.
    const cur = this.current();
    if (this.editing && cur)
      for (const p of this.presets)
        for (const c of p.layout.controls)
          if (p !== cur && c.type === 'layer' && c.target === cur.id) {
            const el = document.createElement('div');
            el.className = `ctl layer ghost size-${c.size}`;
            el.textContent = ctlText(c);
            this.root.append(el);
            this.extra.set(el, c);
          }
    this.root.classList.toggle('editing', this.editing);
    this.paintSelected();
    this.place();
  }

  place() {
    const r = this.root.getBoundingClientRect();
    const put = (c: Control, el: HTMLElement) => {
      const px = c.type === 'dpad' ? DPAD_PX[c.size] : PX[c.size];
      el.style.width = el.style.height = `${px}px`;
      el.style.left = `${Math.round(c.x * r.width - px / 2)}px`;
      el.style.top = `${Math.round(c.y * r.height - px / 2)}px`;
    };
    for (const c of this.layout.controls) {
      const el = this.els.get(c.id);
      if (el) put(c, el);
    }
    for (const [el, c] of this.extra) put(c, el);
  }

  /** Giữ nút giữ: hiện bố cục đích chồng lên, ẩn các nút khác (trừ nút đang có ngón giữ, vd D-pad). */
  private showLayer(holder: Control, pid: number) {
    const target = this.presets.find((p) => p.id === holder.target && p.id !== this.current()?.id);
    // Nút giữ nằm trong lớp thì không mở lớp tiếp (tránh lồng nhau).
    const ctls = (target?.layout.controls ?? []).filter((c) => c.type !== 'layer');
    this.layer = { pid, holder, ctls };
    if (!ctls.length) return;
    const busy = new Set([...this.held.values()].map((h) => h.ctl.id));
    for (const [cid, el] of this.els) if (!busy.has(cid)) el.classList.add('off-layer');
    for (const c of ctls) {
      const el = this.makeEl(c);
      el.classList.add('in-layer');
      this.root.append(el);
      this.extra.set(el, c);
    }
    this.place();
  }

  /** Thả nút giữ: nhả phím các nút trong lớp còn đang giữ, bỏ lớp, hiện lại bố cục cũ. */
  private hideLayer() {
    const l = this.layer;
    if (!l) return;
    this.layer = null;
    const ids = new Set(l.ctls.map((c) => c.id));
    for (const [pid, h] of this.held)
      if (ids.has(h.ctl.id)) {
        for (const key of h.keys) this.sendKey(key, false);
        this.held.delete(pid);
      }
    for (const [el, c] of this.extra)
      if (ids.has(c.id)) {
        el.remove();
        this.extra.delete(el);
      }
    for (const el of this.els.values()) el.classList.remove('off-layer');
  }

  setEditing(on: boolean) {
    this.editing = on;
    this.selected = null;
    this.onSelect(null);
    this.render();
  }

  select(idv: string | null) {
    this.selected = idv;
    this.paintSelected();
    this.onSelect(this.layout.controls.find((c) => c.id === idv) ?? null);
  }

  private paintSelected() {
    for (const [cid, el] of this.els) el.classList.toggle('selected', cid === this.selected);
  }

  update(c: Control) {
    this.save();
    this.render();
    this.select(c.id);
  }

  add(type: 'key' | 'dpad' | 'layer') {
    const c: Control = type === 'key' ? k('KeyQ', 0.5, 0.5) : { id: id(), type, x: 0.5, y: 0.5, size: 'm' };
    this.layout.controls.push(c);
    this.update(c);
  }

  remove(c: Control) {
    this.layout.controls = this.layout.controls.filter((x) => x.id !== c.id);
    this.save();
    this.select(null);
    this.render();
  }

  /** Preset đang dùng về bố cục mặc định của app. */
  reset() {
    this.layout = this.defaults();
    const p = this.current();
    if (p) p.layout = this.layout;
    this.save();
    this.select(null);
    this.render();
  }

  /** Rời trang, ẩn app, mất focus: nhả hết phím đang giữ. */
  releaseAll() {
    for (const [pid, h] of this.held) {
      for (const key of h.keys) this.sendKey(key, false);
      this.els.get(h.ctl.id)?.classList.remove('down');
      this.held.delete(pid);
    }
    this.hideLayer();
  }

  // --- Thao tác ---------------------------------------------------------------------------------
  private drag: { pid: number; dx: number; dy: number; moved: boolean } | null = null;

  private down(e: PointerEvent, c: Control, el: HTMLElement) {
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    if (this.editing) {
      const r = el.getBoundingClientRect();
      this.drag = { pid: e.pointerId, dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2), moved: false };
      this.select(c.id);
      // Đang kéo nút: thanh sửa mờ đi và không chặn ngón, để thả nút được cả dưới thanh.
      this.root.classList.add('dragging');
      return;
    }
    // Đang giữ một nút giữ thì nút giữ khác không làm gì (một lớp một lúc).
    if (c.type === 'layer' && this.layer) return;
    const keys = c.type === 'dpad' ? this.dpadKeys(e, el) : new Set(c.key ? [c.key] : []);
    this.held.set(e.pointerId, { ctl: c, keys });
    for (const key of keys) this.sendKey(key, true);
    el.classList.add('down');
    if (c.type === 'dpad') this.paintDpad(el, e, keys);
    if (c.type === 'layer') this.showLayer(c, e.pointerId);
  }

  private move(e: PointerEvent, c: Control, el: HTMLElement) {
    if (this.editing) {
      if (!this.drag || this.drag.pid !== e.pointerId) return;
      const r = this.root.getBoundingClientRect();
      c.x = Math.min(1, Math.max(0, (e.clientX - this.drag.dx - r.left) / r.width));
      c.y = Math.min(1, Math.max(0, (e.clientY - this.drag.dy - r.top) / r.height));
      this.drag.moved = true;
      this.place();
      return;
    }
    if (c.type !== 'dpad') return;
    const h = this.held.get(e.pointerId);
    if (!h) return;
    // Trượt ngón trên D-pad: nhả hướng cũ, nhấn hướng mới (đi chéo = giữ hai phím, vd leo dây + đi ngang).
    const next = this.dpadKeys(e, el);
    for (const key of h.keys) if (!next.has(key)) this.sendKey(key, false);
    for (const key of next) if (!h.keys.has(key)) this.sendKey(key, true);
    h.keys = next;
    this.paintDpad(el, e, next);
  }

  private up(e: PointerEvent, c: Control, el: HTMLElement) {
    if (this.editing) {
      if (this.drag?.moved) this.save();
      this.drag = null;
      this.root.classList.remove('dragging');
      return;
    }
    const h = this.held.get(e.pointerId);
    if (!h) return;
    for (const key of h.keys) this.sendKey(key, false);
    this.held.delete(e.pointerId);
    el.classList.remove('down');
    if (c.type === 'dpad') this.paintDpad(el, null, new Set());
    if (c.type === 'layer' && this.layer?.pid === e.pointerId) this.hideLayer();
  }

  /** Hướng theo vị trí ngón so với tâm: 8 hướng, vùng chết ở giữa. */
  private dpadKeys(e: PointerEvent, el: HTMLElement): Set<string> {
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const keys = new Set<string>();
    if (Math.hypot(dx, dy) < r.width * 0.12) return keys;
    const a = (Math.atan2(dy, dx) * 180) / Math.PI; // 0 = phải, 90 = xuống
    if (a > -67.5 && a < 67.5) keys.add('ArrowRight');
    if (a > 112.5 || a < -112.5) keys.add('ArrowLeft');
    if (a > 22.5 && a < 157.5) keys.add('ArrowDown');
    if (a < -22.5 && a > -157.5) keys.add('ArrowUp');
    return keys;
  }

  private paintDpad(el: HTMLElement, e: PointerEvent | null, keys: Set<string>) {
    el.querySelector('.u')!.classList.toggle('on', keys.has('ArrowUp'));
    el.querySelector('.d')!.classList.toggle('on', keys.has('ArrowDown'));
    el.querySelector('.l')!.classList.toggle('on', keys.has('ArrowLeft'));
    el.querySelector('.r')!.classList.toggle('on', keys.has('ArrowRight'));
    const knob = el.querySelector<HTMLElement>('.knob')!;
    if (!e) return void (knob.style.transform = '');
    const r = el.getBoundingClientRect();
    const max = r.width * 0.3;
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > max) [dx, dy] = [(dx / d) * max, (dy / d) * max];
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}

/** Danh sách phím cho ô chọn trong bảng sửa nút. */
export const KEY_OPTIONS = Object.keys(KEYS).map((code) => ({ code, label: `${keyLabel(code)}${keyLabel(code) === code ? '' : ` (${code})`}` }));
