// Đổi màn hình máy cho hợp điện thoại: xoay dọc/ngang và cỡ chữ (tỉ lệ co giãn DPI của Windows) cho một màn hình.
// - Xoay: ChangeDisplaySettingsExW với cờ 0 (đổi tạm, không ghi vào registry): khởi động lại máy là về như cũ.
// - Cỡ chữ: Windows không có API công khai. Dùng DisplayConfigSetDeviceInfo kiểu -4 (DPI_SCALE), cách Settings và
//   công cụ SetDPI làm: tỉ lệ tính theo bậc so với mức Windows khuyên dùng. Mức này Windows nhớ lại, nên sidecar luôn
//   ghi mức cũ ra tệp trước khi đổi để trả về (kể cả sau khi sidecar chết ngang, xem src/apps/desktop.ts).
import { dlopen, FFIType, ptr } from 'bun:ffi';

const u = dlopen('user32.dll', {
  EnumDisplaySettingsW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  ChangeDisplaySettingsExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  GetDisplayConfigBufferSizes: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  QueryDisplayConfig: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  DisplayConfigGetDeviceInfo: { args: [FFIType.ptr], returns: FFIType.i32 },
  DisplayConfigSetDeviceInfo: { args: [FFIType.ptr], returns: FFIType.i32 },
}).symbols;

const wstr = (s: string) => Buffer.from(s + '\0', 'utf16le');

// --- Xoay -----------------------------------------------------------------------------------------
// DEVMODEW (220 byte): dmSize@68, dmFields@72, dmDisplayOrientation@84, dmPelsWidth@172, dmPelsHeight@176.
const DM_SIZE = 220;
const DM_DISPLAYORIENTATION = 0x80, DM_PELSWIDTH = 0x80000, DM_PELSHEIGHT = 0x100000;
/** 0 = ngang (mặc định), 1 = dọc (xoay 90°), 2 = ngang lật, 3 = dọc lật. */
export type Orientation = 0 | 1 | 2 | 3;

function currentMode(device: string) {
  const buf = new Uint8Array(DM_SIZE);
  const dv = new DataView(buf.buffer);
  dv.setUint16(68, DM_SIZE, true);
  if (!u.EnumDisplaySettingsW(wstr(device), 0xffffffff, ptr(buf))) return null; // ENUM_CURRENT_SETTINGS
  return { buf, dv, orientation: dv.getUint32(84, true) as Orientation, w: dv.getUint32(172, true), h: dv.getUint32(176, true) };
}

export function getOrientation(device: string): Orientation | null {
  return currentMode(device)?.orientation ?? null;
}

export function setOrientation(device: string, o: Orientation): boolean {
  const m = currentMode(device);
  if (!m) return false;
  if (m.orientation === o) return true;
  let { w, h } = m;
  if (m.orientation % 2 !== o % 2) [w, h] = [h, w];
  m.dv.setUint32(72, DM_DISPLAYORIENTATION | DM_PELSWIDTH | DM_PELSHEIGHT, true);
  m.dv.setUint32(84, o, true);
  m.dv.setUint32(172, w, true);
  m.dv.setUint32(176, h, true);
  return u.ChangeDisplaySettingsExW(wstr(device), ptr(m.buf), 0n, 0, null) === 0; // DISP_CHANGE_SUCCESSFUL
}

// --- Cỡ chữ (DPI) ------------------------------------------------------------------------------------
/** Các mức Windows có, theo thứ tự bậc. */
const DPI = [100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500];

/** adapterId + id của nguồn hình (source) đang hiện ra màn hình có tên GDI này. */
function sourceOf(device: string): { lo: number; hi: number; id: number } | null {
  const np = new Uint32Array(1), nm = new Uint32Array(1);
  if (u.GetDisplayConfigBufferSizes(2, ptr(np), ptr(nm)) || !np[0]) return null; // QDC_ONLY_ACTIVE_PATHS
  const paths = new Uint8Array(72 * np[0]); // DISPLAYCONFIG_PATH_INFO
  const modes = new Uint8Array(64 * Math.max(1, nm[0])); // DISPLAYCONFIG_MODE_INFO
  if (u.QueryDisplayConfig(2, ptr(np), ptr(paths), ptr(nm), ptr(modes), null)) return null;
  const dv = new DataView(paths.buffer);
  for (let i = 0; i < np[0]; i++) {
    const o = i * 72;
    const src = { lo: dv.getUint32(o, true), hi: dv.getInt32(o + 4, true), id: dv.getUint32(o + 8, true) };
    // DISPLAYCONFIG_SOURCE_DEVICE_NAME: header (20 byte) + viewGdiDeviceName[32]. Kiểu 1 = GET_SOURCE_NAME.
    const req = header(1, 84, src);
    if (u.DisplayConfigGetDeviceInfo(ptr(req.buf))) continue;
    const name = Buffer.from(req.buf.buffer, 20, 64).toString('utf16le').split(String.fromCharCode(0))[0];
    if (name.toLowerCase() === device.toLowerCase()) return src;
  }
  return null;
}

function header(type: number, size: number, s: { lo: number; hi: number; id: number }) {
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, type, true);
  dv.setUint32(4, size, true);
  dv.setUint32(8, s.lo, true);
  dv.setInt32(12, s.hi, true);
  dv.setUint32(16, s.id, true);
  return { buf, dv };
}

export interface Scale {
  /** Mức đang dùng, phần trăm. */
  percent: number;
  /** Mức Windows khuyên dùng cho màn hình này. */
  recommended: number;
  /** Các mức chọn được. */
  options: number[];
}

export function getScale(device: string): Scale | null {
  const s = sourceOf(device);
  if (!s) return null;
  // Kiểu -3 = GET_DPI_SCALE: minScaleRel, curScaleRel, maxScaleRel (bậc so với mức khuyên dùng).
  const r = header(-3, 32, s);
  if (u.DisplayConfigGetDeviceInfo(ptr(r.buf))) return null;
  const min = r.dv.getInt32(20, true), cur = r.dv.getInt32(24, true), max = r.dv.getInt32(28, true);
  const rec = Math.abs(min);
  return { percent: DPI[rec + cur] ?? 100, recommended: DPI[rec] ?? 100, options: DPI.slice(0, rec + max + 1) };
}

export function setScale(device: string, percent: number): boolean {
  const s = sourceOf(device);
  const now = getScale(device);
  if (!s || !now) return false;
  if (now.percent === percent) return true;
  const idx = DPI.indexOf(now.options.includes(percent) ? percent : now.options.at(-1)!);
  const r = header(-4, 24, s); // SET_DPI_SCALE: scaleRel
  r.dv.setInt32(20, idx - DPI.indexOf(now.recommended), true);
  return u.DisplayConfigSetDeviceInfo(ptr(r.buf)) === 0;
}
