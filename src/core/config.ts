// Cấu hình chung của sidecar: cổng (pcpilot.json), danh sách máy và chủ tài khoản (machines.json).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accessMode, type AccessConfig } from './access';

export const ROOT = resolve(import.meta.dir, '..', '..');
export const REPO = ROOT;

export interface Config {
  port: number;
  httpsPort: number;
  unityPort: number;
  /** Cổng tiến trình gửi phím quyền admin (src/elevated.ts) nghe, sidecar nối vào (TCP 127.0.0.1). */
  inputPort: number;
  /** Thư mục quét tìm project Unity (2 tầng). Rỗng: chỉ các project Unity Hub đã biết. */
  projectRoots?: string[];
}

export const cfg = JSON.parse(readFileSync(resolve(ROOT, 'pcpilot.json'), 'utf8')) as Config;
export const PORT = Number(process.env.PCPILOT_PORT ?? cfg.port);
/** Cổng Unity Editor nối vào. Chạy thử sidecar thứ hai cạnh sidecar thật: PCPILOT_PORT=7451 PCPILOT_UNITY_PORT=7452 PCPILOT_INPUT_PORT=7453. */
export const UNITY_PORT = Number(process.env.PCPILOT_UNITY_PORT ?? cfg.unityPort);
/** Cổng tiến trình gửi phím quyền admin. Sidecar thử: thêm PCPILOT_INPUT_PORT=7453 để không nối nhầm vào tiến trình thật. */
export const INPUT_PORT = Number(process.env.PCPILOT_INPUT_PORT ?? cfg.inputPort);

export const machinesCfg = JSON.parse(readFileSync(resolve(ROOT, 'machines.json'), 'utf8')) as {
  owner: string;
  /** Cách điện thoại vào sidecar: tailscale | cloudflare | proxy | local (xem src/core/access.ts, README). */
  access?: AccessConfig;
  /** url: địa chỉ HTTPS của sidecar máy đó khi không dùng Tailscale (vd https://pc1-unity.example.com). */
  machines: { name: string; computer: string; host?: string; url?: string }[];
};
export const ACCESS = accessMode(machinesCfg.access);
const computer = (process.env.COMPUTERNAME ?? '').toUpperCase();
export const self = machinesCfg.machines.find((m) => m.computer.toUpperCase() === computer) ?? { name: computer || '?', computer, host: '' };

export const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

// Đuôi tên miền tailnet (vd tailxxxx.ts.net): trang mở từ localhost vẫn biết địa chỉ sidecar máy khác.
export const net = { tailnet: '' };
if (ACCESS === 'tailscale') (async () => {
  try {
    const ts = Bun.which('tailscale') ?? 'C:\\Program Files\\Tailscale\\tailscale.exe';
    const p = Bun.spawn([ts, 'status', '--json'], { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
    const j = JSON.parse(await new Response(p.stdout).text());
    net.tailnet = String(j.MagicDNSSuffix ?? j.CurrentTailnet?.MagicDNSSuffix ?? '');
  } catch {}
})();

// --- Chất lượng -----------------------------------------------------------------------------------
export type Quality = 'low' | 'medium' | 'high' | 'max';
/** short = cạnh ngắn của khung gửi đi (không phóng to quá cỡ gốc). */
export const QUALITY: Record<Quality, { short: number; kbps: number }> = {
  low: { short: 360, kbps: 1200 },
  medium: { short: 540, kbps: 2500 },
  high: { short: 720, kbps: 4000 },
  max: { short: 1080, kbps: 8000 },
};
