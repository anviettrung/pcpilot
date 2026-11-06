// Phần dùng chung của trang: trạng thái, kết nối tới các máy, tiện ích giao diện. app.ts nối mọi thứ lại; mỗi app
// (web/apps/) dùng các hàm ở đây và khai giao diện riêng qua WebApp.
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const now = () => performance.timeOrigin + performance.now();
export const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
export const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : NaN);
export const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x) : '–');
export const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const canvas = $<HTMLCanvasElement>('video');
export const stage = $('stage');
export const params = new URLSearchParams(location.search);
// Không có WebCodecs (hoặc thử bằng ?jpeg) thì nhận ảnh JPEG (chỉ nguồn Unity có).
export const useJpeg = !('VideoDecoder' in window) || params.has('jpeg');

// --- Cài đặt lưu trên máy -------------------------------------------------------------------------
export interface MachineInfo {
  name: string;
  host?: string;
  /** Địa chỉ HTTPS của sidecar máy đó (url khai báo, hoặc địa chỉ tailnet). Không có: chỉ dùng tại chỗ. */
  url?: string;
}
const PREF = 'unitypilot:prefs';
export const prefs: {
  quality: string;
  fps: number;
  aspect: string;
  compact?: boolean;
  showTouches?: boolean;
  miniPos?: [number, number];
  /** Máy đang xem, danh sách máy, đuôi tailnet: nhớ lại để máy chủ của trang có tắt thì vẫn nối được máy kia. */
  view?: string;
  home?: string;
  machines?: MachineInfo[];
  tailnet?: string;
  httpsPort?: number;
  /** App xem lần trước trên từng máy. */
  apps?: Record<string, string>;
} = {
  quality: 'high',
  fps: 30,
  aspect: 'free',
  ...JSON.parse(localStorage.getItem(PREF) ?? '{}'),
};
export const savePrefs = () => localStorage.setItem(PREF, JSON.stringify(prefs));

// --- Kết nối tới các máy --------------------------------------------------------------------------
// Trang nối tới sidecar của mọi máy (machines.json): máy đang xem nhận hình, các máy khác chỉ gửi trạng thái.
export interface Link {
  url: string;
  name: string;
  ws: WebSocket | null;
  open: boolean;
  status: any;
  retry: number;
  /** Dữ liệu riêng của app theo máy (vd danh sách project Unity). */
  data: Record<string, any>;
}
export const links: Link[] = [];
export const S = {
  view: null as unknown as Link,
  lastFrameAt: 0,
  drawn: 0,
};
export const status = () => S.view?.status;
export const isOpen = () => !!S.view?.open;

export function sendTo(l: Link, m: object) {
  if (l.ws && l.open) l.ws.send(JSON.stringify(m));
}
export const send = (m: object) => S.view && sendTo(S.view, m);

export function machineOrder(l: Link) {
  const i = (prefs.machines ?? []).findIndex((m) => m.name === l.name);
  return i < 0 ? 99 : i;
}
export const sortedLinks = () => [...links].sort((a, b) => machineOrder(a) - machineOrder(b));

// --- Đo ------------------------------------------------------------------------------------------
// Lấy mẫu trong 5 giây gần nhất cho thanh trạng thái; chế độ autotest giữ hết.
export const samples = { video: [] as number[], input: [] as number[], decode: [] as number[], net: [] as number[], rtt: [] as number[] };
export const allSamples = { video: [] as number[], input: [] as number[], decode: [] as number[], net: [] as number[], rtt: [] as number[] };
export function sample(kind: keyof typeof samples, v: number) {
  samples[kind].push(v);
  if (samples[kind].length > 150) samples[kind].shift();
  allSamples[kind].push(v);
}

/** Thao tác đã gửi chờ thấy trên hình (đo chạm→hiện): số thứ tự → lúc gửi. Nguồn hình gắn số thao tác vào khung. */
export const sentAt = new Map<number, number>();
let inputSeq = 0;
export function nextInputSeq(): number {
  const s = ++inputSeq;
  sentAt.set(s, now());
  if (sentAt.size > 200) sentAt.delete(sentAt.keys().next().value!);
  return s;
}
export function resolveInput(frameSeq: number, t: number) {
  if (!frameSeq) return;
  for (const [s, at] of sentAt) {
    if (s > frameSeq) break;
    sample('input', t - at);
    sentAt.delete(s);
  }
}

/** Việc app.ts làm, app gọi được (app.ts gán lúc khởi động). */
export const actions = {} as {
  switchView(l: Link): void;
  openSheet(open: boolean): void;
  /** Chuyển máy (mặc định máy đang xem) sang app khác, nhớ lại cho lần sau. */
  selectApp(id: string, l?: Link): void;
  sendView(): void;
  render(): void;
  stats(): { frameCount: number; keyCount: number; bytes: number; drawn: number; codec: string; size: string };
};

// --- App -----------------------------------------------------------------------------------------
export interface Overlay {
  title: string;
  text?: string;
  spin?: boolean;
  /** Nút Play to giữa màn hình (Unity). */
  play?: boolean;
  /** Nút mở bảng chọn (chọn project). */
  pick?: string;
  /** Nút việc riêng của app. */
  action?: { label: string; run: () => void; secondary?: boolean };
}

export interface WebApp {
  id: string;
  /** Nhóm nút trên thanh dưới và phần riêng trong bảng ☰ (data-group / data-section trong index.html). */
  group: string;
  section?: string;
  icon: string;
  /** Khởi tạo một lần lúc mở trang. */
  init(): void;
  /** Máy đang xem chuyển sang app này (on) hoặc rời app này. */
  enter?(on: boolean): void;
  /** Lớp phủ riêng khi có hình chưa xem được (null = không có gì để báo). */
  overlay?(st: any, a: any): Overlay | null;
  /** Mỗi nửa giây: cập nhật nút riêng trên thanh. */
  render?(st: any, a: any): void;
  /** Bảng ☰ đang mở: vẽ phần riêng. */
  sheet?(st: any, a: any): void;
  /** Chữ sau tên máy trên thanh dưới. */
  label?(a: any): string;
  /** Dòng thông tin thêm ở đầu bảng ☰. */
  info?(a: any): string;
  /** Đang "chơi" (giữ màn hình sáng, hiện độ trễ). Mặc định: đang có hình. */
  live?(st: any, a: any): boolean;
  onJson?(l: Link, m: any): boolean;
  /** Thông tin thêm gửi kèm lệnh view (vd tỉ lệ màn hình cho Unity). */
  view?(): object;
  /** Chạm lên hình. */
  pointer?(e: PointerEvent, ph: 'down' | 'move' | 'up' | 'cancel'): void;
  /** Rời trang, ẩn app, mất focus: nhả hết chạm đang giữ. */
  releaseAll?(): void;
  /** Hàng thông số đo riêng. */
  metrics?(st: any): [string, string][];
}

// --- Giao diện chung --------------------------------------------------------------------------------
let toastTimer = 0;
export function toast(text: string, error = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), error ? 6000 : 3500);
}
$('toast').onclick = () => ($('toast').hidden = true);

/** Hộp hỏi nhỏ (confirm của trình duyệt không chọn được nhiều nút). */
export function ask(title: string, text: string, buttons: [string, string, string][]): Promise<string | null> {
  const dlg = $('dialog');
  $('dialogTitle').textContent = title;
  $('dialogText').textContent = text;
  const row = $('dialogButtons');
  row.innerHTML = '';
  return new Promise((done) => {
    const finish = (v: string | null) => {
      dlg.hidden = true;
      done(v);
    };
    for (const [v, label, cls] of [...buttons, ['', 'Huỷ', ''] as [string, string, string]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.className = cls;
      b.onclick = () => finish(v || null);
      row.append(b);
    }
    dlg.onclick = (e) => e.target === dlg && finish(null);
    dlg.hidden = false;
  });
}

/** Toạ độ chạm trên hình (0..1, gốc trên trái). */
export function videoPoint(e: { clientX: number; clientY: number }) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}
