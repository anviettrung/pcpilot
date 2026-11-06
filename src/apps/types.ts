// Giao diện chung cho mỗi app UnityPilot điều khiển được. Lõi (src/main.ts) lo web, bảo mật, encode, gửi khung; mỗi
// app chỉ khai phần riêng của nó: tự đưa khung RGBA (vd Unity chụp Game view) qua host.pushRaw() và tự xử lý thao tác
// (chạm ảo trong Unity) qua onMessage.
// App mới: thêm một tệp trong src/apps/, khai trong APPS ở src/apps/index.ts, và phần giao diện trong web/apps/.
import type { ServerWebSocket } from 'bun';
import type { Quality } from '../core/config';
import type { FrameMeta } from '../core/encoder';

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
  /** [số chạm toàn cục, số chạm của chính client]: dịch số nguồn hình gắn vào khung về số của client (đo chạm→hiện). */
  seqMap: [number, number][];
}

/** Cỡ khung người xem sau cùng muốn: cạnh ngắn theo chất lượng, tỉ lệ theo màn hình điện thoại hoặc tỉ lệ đã chọn. */
export interface StreamTarget {
  w: number;
  h: number;
  fps: number;
  kbps: number;
  quality: Quality;
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
  /** Gọi lại việc chọn nguồn hình ngay (Unity vừa nối...). */
  refresh(): void;
  /** App đưa một khung RGBA. */
  pushRaw(f: RawFrame): void;
  /** Cấp số chạm toàn cục cho một chạm của client (mỗi client tự đếm từ 1, nhiều client thì trùng). */
  inputSeq(c: Client, clientSeq: number): number;
  readonly clients: Map<WS, Client>;
}

export interface App {
  id: string;
  name: string;
  init(host: Host): void;
  /** Bật nguồn hình theo cỡ khung, hoặc tắt (null). Chỉ app đang xem được bật. */
  stream(target: StreamTarget | null): void;
  /** Trạng thái riêng của app, gửi kèm trạng thái chung mỗi giây (status.apps[id]). */
  status(): Record<string, unknown>;
  /** Trang mới nối: gửi riêng những gì app có (danh sách project...). */
  onOpen?(ws: WS): void;
  /** Sidecar sắp thoát: trả máy về như cũ. Phải chạy đồng bộ. */
  shutdown?(): void;
  /** Tin nhắn riêng của app. Trả true nếu đã xử lý. */
  onMessage?(ws: WS, c: Client, m: any): boolean;
}
