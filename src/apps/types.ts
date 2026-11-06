// Giao diện chung cho mỗi app PcPilot điều khiển được. Lõi (src/main.ts) lo web, bảo mật, encode, gửi khung, gửi
// phím chuột; mỗi app chỉ khai phần riêng của nó:
// - Nguồn hình 'screen': app chỉ ra vùng màn hình cần chụp (cả màn hình, một cửa sổ, hay một phần cửa sổ), lõi chụp
//   bằng ddagrab và gửi phím chuột (SendInput) vào đúng vùng đó. Remote màn hình, app theo cửa sổ (WindowApp) là kiểu này.
// - Nguồn hình 'raw': app tự đưa khung RGBA (vd Unity chụp Game view) và tự xử lý thao tác (chạm ảo trong Unity).
// App mới: thêm một tệp trong src/apps/, khai trong APPS ở src/apps/index.ts, và phần giao diện trong web/apps/.
import type { ServerWebSocket } from 'bun';
import type { Quality } from '../core/config';
import type { FrameMeta } from '../core/encoder';
import type { InputBridge } from '../screen/bridge';
import type { Monitor } from '../screen/win32';

export type WS = ServerWebSocket<unknown>;

export interface Client {
  /** Xem hình. false = trang đang xem máy khác, chỉ nhận trạng thái. */
  watch: boolean;
  needKey: boolean;
  viewW: number;
  viewH: number;
  quality: Quality;
  fps: number;
  jpeg: boolean;
  aspect: string;
  /** App trang muốn xem trên máy này. */
  app: string;
  /** Phím và nút chuột client này đang giữ: mất kết nối thì nhả hết, không để kẹt. */
  held: Set<string>;
  buttons: Set<string>;
  /** [số chạm toàn cục, số chạm của chính client]: dịch số nguồn hình gắn vào khung về số của client (đo chạm→hiện). */
  seqMap: [number, number][];
  /** Chế độ điện thoại của app Màn hình: xoay màn hình máy theo điện thoại, tăng cỡ chữ (scale = %, 0 = như cũ). */
  mobile: { on: boolean; rotate: 'auto' | 'portrait' | 'off'; scale: number };
}

/** Cỡ khung người xem sau cùng muốn: cạnh ngắn theo chất lượng, tỉ lệ theo màn hình điện thoại hoặc tỉ lệ đã chọn. */
export interface StreamTarget {
  w: number;
  h: number;
  fps: number;
  kbps: number;
  quality: Quality;
}

/** Vùng màn hình cần chụp, theo toạ độ màn hình ảo (pixel thật). */
export interface ScreenRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Màn hình chứa vùng này (ddagrab chụp từng màn hình). */
  monitor: Monitor;
  /** Cửa sổ đang chụp: biết nó có đang ở trên cùng không, đưa nó lên trên. */
  hwnd?: bigint;
  /** Cửa sổ cùng lớp cũng tính là "của app" (vd khung chat tách rời của game). */
  cls?: string;
  /** Vẽ con trỏ chuột (mặc định có). */
  cursor?: boolean;
}

export interface RawFrame extends Omit<FrameMeta, 'receivedMs'> {
  rgba: Uint8Array;
}

export interface Host {
  log(...a: unknown[]): void;
  notice(ws: WS, text: string, error?: boolean): void;
  /** Gửi JSON tới mọi trang đang nối. */
  broadcast(obj: object): void;
  broadcastStatus(): void;
  /** App này có đang được xem không. */
  isActive(id: string): boolean;
  /** Chuyển máy này sang xem app khác (vd mở project Unity từ trang). */
  activate(id: string): void;
  /** Gọi lại việc chọn nguồn hình ngay (app vừa đổi vùng chụp, Unity vừa nối...). */
  refresh(): void;
  /** App 'raw' đưa một khung RGBA. */
  pushRaw(f: RawFrame): void;
  /** Cấp số chạm toàn cục cho một chạm của client (mỗi client tự đếm từ 1, nhiều client thì trùng). */
  inputSeq(c: Client, clientSeq: number): number;
  readonly clients: Map<WS, Client>;
  readonly input: InputBridge;
}

export interface App {
  id: string;
  name: string;
  source: 'screen' | 'raw';
  /** Chỉ gửi phím, chuột khi cửa sổ của app đang ở trên cùng (luật an toàn cho game có anti-cheat). */
  requireForeground?: boolean;
  init(host: Host): void;
  /** 'screen': vùng cần chụp lúc này, hoặc mã lý do không chụp được (trang hiện thông báo theo mã). */
  region?(): ScreenRegion | string;
  /** 'raw': bật nguồn hình theo cỡ khung, hoặc tắt (null). */
  stream?(target: StreamTarget | null): void;
  /** Trạng thái riêng của app, gửi kèm trạng thái chung mỗi giây (status.apps[id]). */
  status(): Record<string, unknown>;
  /** Trang mới nối: gửi riêng những gì app có (danh sách project...). */
  onOpen?(ws: WS): void;
  /** Sidecar sắp thoát: trả máy về như cũ (vd màn hình đã xoay). Phải chạy đồng bộ. */
  shutdown?(): void;
  /** Tin nhắn riêng của app. Trả true nếu đã xử lý. */
  onMessage?(ws: WS, c: Client, m: any): boolean;
}
