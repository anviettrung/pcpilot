// Cổng TCP cho Unity Editor (package com.unitypilot.unity) nối vào. Chỉ nghe ở 127.0.0.1.
// Gói tin: u32 độ dài phần sau | u8 loại | nội dung (xem unity/Editor/PilotBridge.cs).
// Nhiều Editor (nhiều project) nối cùng lúc được; mỗi Editor nhận diện bằng đường dẫn project trong gói trạng thái.
import type { Socket } from 'bun';
import { normPath } from './projects';

export const MSG_STATUS = 1;
export const MSG_FRAME = 2;
export const MSG_COMMAND = 10;

export interface UnityStatus {
  project: string;
  /** Đường dẫn project (bản package cũ không gửi). */
  path?: string;
  pid?: number;
  /** Scene đang mở có thay đổi chưa lưu. */
  dirty?: boolean;
  unity: string;
  scene: string;
  platform: string;
  playing: boolean;
  paused: boolean;
  compiling: boolean;
  reloading: boolean;
  quitting?: boolean;
  screenW: number;
  screenH: number;
}

export interface RawFrame {
  width: number;
  height: number;
  frameId: number;
  captureMs: number;
  inputSeq: number;
  rgba: Uint8Array;
}

export interface Editor {
  /** Khoá so sánh (normPath), rỗng tới khi nhận gói trạng thái đầu tiên. */
  key: string;
  status: UnityStatus | null;
  connectedAt: number;
  /** Lần cuối gửi lệnh stream bật. */
  streamOn: boolean;
}

export interface UnityEvents {
  onConnect(e: Editor): void;
  onDisconnect(e: Editor): void;
  onStatus(e: Editor): void;
  onFrame(e: Editor, f: RawFrame): void;
}

type Conn = { buf: Uint8Array; len: number; ed: Editor; out: Uint8Array };

function concat(a: Uint8Array, b: Uint8Array) {
  const r = new Uint8Array(a.length + b.length);
  r.set(a);
  r.set(b, a.length);
  return r;
}

export class UnityLink {
  private socks = new Set<Socket<Conn>>();
  /** Editor vừa báo "đang reload/compile" rồi mất kết nối: khoá → lúc mất. Chờ nó nối lại thay vì báo "đã tắt". */
  readonly reloading = new Map<string, number>();

  constructor(port: number, private ev: UnityEvents) {
    Bun.listen<Conn>({
      hostname: '127.0.0.1',
      port,
      socket: {
        open: (s) => {
          s.data = { buf: new Uint8Array(8 << 20), len: 0, out: new Uint8Array(0), ed: { key: '', status: null, connectedAt: Date.now(), streamOn: false } };
          this.socks.add(s);
        },
        data: (s, chunk) => this.onData(s, chunk),
        drain: (s) => this.flush(s),
        close: (s) => {
          if (!this.socks.delete(s)) return;
          const ed = s.data.ed;
          if (!ed.key) return;
          if ((ed.status?.reloading || ed.status?.compiling) && !ed.status?.quitting) this.reloading.set(ed.key, Date.now());
          this.ev.onDisconnect(ed);
        },
        error: () => {},
      },
    });
  }

  /** Editor đã nhận diện, mới nối sau cùng ở cuối. */
  get editors(): Editor[] {
    return [...this.socks].map((s) => s.data.ed).filter((e) => e.key).sort((a, b) => a.connectedAt - b.connectedAt);
  }

  get(key: string): Editor | undefined {
    const eds = this.editors;
    // Package bản cũ không gửi đường dẫn (khoá "?tên"): khớp theo tên thư mục project.
    return eds.find((e) => e.key === key) ?? eds.find((e) => e.key.startsWith('?') && key.endsWith(`\\${e.key.slice(1).toLowerCase()}`));
  }

  isReloading(key: string) {
    const t = this.reloading.get(key);
    return !!t && Date.now() - t < 60_000;
  }

  send(ed: Editor, cmd: Record<string, unknown>) {
    const s = [...this.socks].find((x) => x.data.ed === ed);
    if (!s) return;
    const body = new TextEncoder().encode(JSON.stringify(cmd));
    const msg = new Uint8Array(5 + body.length);
    new DataView(msg.buffer).setUint32(0, body.length + 1, true);
    msg[4] = MSG_COMMAND;
    msg.set(body, 5);
    s.data.out = s.data.out.length ? concat(s.data.out, msg) : msg;
    this.flush(s);
  }

  private flush(s: Socket<Conn>) {
    const c = s.data;
    if (!c.out.length) return;
    const n = s.write(c.out);
    c.out = n >= c.out.length ? new Uint8Array(0) : c.out.slice(Math.max(0, n));
  }

  private onData(s: Socket<Conn>, chunk: Uint8Array) {
    const c = s.data;
    if (c.len + chunk.length > c.buf.length) {
      const bigger = new Uint8Array(Math.max(c.buf.length * 2, c.len + chunk.length));
      bigger.set(c.buf.subarray(0, c.len));
      c.buf = bigger;
    }
    c.buf.set(chunk, c.len);
    c.len += chunk.length;

    let off = 0;
    const dv = new DataView(c.buf.buffer, c.buf.byteOffset);
    while (c.len - off >= 5) {
      const n = dv.getUint32(off, true);
      if (c.len - off - 4 < n) break;
      const type = c.buf[off + 4];
      const body = c.buf.subarray(off + 5, off + 4 + n);
      this.handle(s, type, body);
      off += 4 + n;
    }
    if (off > 0) {
      c.buf.copyWithin(0, off, c.len);
      c.len -= off;
    }
  }

  private handle(s: Socket<Conn>, type: number, body: Uint8Array) {
    const ed = s.data.ed;
    if (type === MSG_STATUS) {
      let st: UnityStatus;
      try {
        st = JSON.parse(new TextDecoder().decode(body)) as UnityStatus;
      } catch {
        return;
      }
      ed.status = st;
      if (!ed.key) {
        ed.key = st.path ? normPath(st.path) : `?${st.project}`;
        // Cùng project nối lại (domain reload) mà kết nối cũ chưa kịp đóng: bỏ kết nối cũ.
        for (const o of this.socks) if (o !== s && o.data.ed.key === ed.key) { this.socks.delete(o); o.end(); }
        this.reloading.delete(ed.key);
        this.ev.onConnect(ed);
      }
      this.ev.onStatus(ed);
    } else if (type === MSG_FRAME) {
      if (!ed.key) return;
      const dv = new DataView(body.buffer, body.byteOffset, body.length);
      const width = dv.getUint16(0, true);
      const height = dv.getUint16(2, true);
      const frameId = dv.getUint32(4, true);
      const captureMs = dv.getFloat64(8, true);
      const inputSeq = dv.getInt32(16, true);
      const rgba = body.slice(20); // chép ra: bộ đệm nhận sẽ bị ghi đè
      if (rgba.length !== width * height * 4) return;
      this.ev.onFrame(ed, { width, height, frameId, captureMs, inputSeq, rgba });
    }
  }
}
