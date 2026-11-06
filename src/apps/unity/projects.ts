// Danh sách project Unity trên máy này, mở và tắt Unity Editor.
// Nguồn: thư mục trong `projectRoots` (pcpilot.json, quét 2 tầng) + các project Unity Hub đã biết (projects-v1.json).
import { closeSync, cpSync, existsSync, openSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface ProjectInfo {
  path: string;
  name: string;
  version: string;
  /** Có Unity Editor đúng phiên bản trên máy. */
  editor: boolean;
  /** Đủ điều kiện stream: Unity 6000.3+ và có Input System. */
  streamable: boolean;
  /** Đã gắn package PcPilot (junction Assets/PcPilot, hoặc khai com.pcpilot.unity trong manifest.json). */
  linked: boolean;
  /** Unity đang mở project (Temp/UnityLockfile đang bị khoá). */
  open: boolean;
}

export const normPath = (p: string) => resolve(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

const APPDATA = process.env.APPDATA ?? '';
const SKIP = /^(\.|_|node_modules$|Library$|Assets$|Packages$|Temp$|Logs$)/;

function readVersion(dir: string): string | null {
  try {
    const t = readFileSync(join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8');
    return /m_EditorVersion:\s*(\S+)/.exec(t)?.[1] ?? null;
  } catch {
    return null;
  }
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function scanRoot(root: string, depth: number, out: Set<string>) {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const n of names) {
    if (SKIP.test(n)) continue;
    const p = join(root, n);
    if (!isDir(p)) continue;
    if (existsSync(join(p, 'ProjectSettings', 'ProjectVersion.txt'))) out.add(p);
    else if (depth > 1) scanRoot(p, depth - 1, out);
  }
}

function hubProjects(): string[] {
  try {
    const j = JSON.parse(readFileSync(join(APPDATA, 'UnityHub', 'projects-v1.json'), 'utf8'));
    return Object.values<any>(j?.data ?? {}).map((p) => String(p?.path ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}

// --- Unity Editor theo phiên bản ------------------------------------------------------------------
function editorDirs(): string[] {
  const dirs = [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Unity', 'Hub', 'Editor')];
  try {
    const p = JSON.parse(readFileSync(join(APPDATA, 'UnityHub', 'secondaryInstallPath.json'), 'utf8'));
    if (typeof p === 'string' && p) dirs.push(p);
  } catch {}
  return dirs;
}

export function findEditor(version: string): string | null {
  for (const d of editorDirs()) {
    const exe = join(d, version, 'Editor', 'Unity.exe');
    if (existsSync(exe)) return exe;
  }
  // Editor thêm tay vào Hub ("Locate"): editors-v2.json ghi đường dẫn tới Unity.exe.
  try {
    const t = readFileSync(join(APPDATA, 'UnityHub', 'editors-v2.json'), 'utf8');
    for (const m of t.matchAll(/"([^"]*?Unity\.exe)"/gi)) {
      const exe = JSON.parse(`"${m[1]}"`) as string;
      if (exe.includes(version) && existsSync(exe)) return exe;
    }
  } catch {}
  return null;
}

/** Unity giữ khoá Temp/UnityLockfile suốt lúc mở project: mở được tệp = không có Unity nào mở. */
export function isOpen(path: string): boolean {
  const lock = join(path, 'Temp', 'UnityLockfile');
  if (!existsSync(lock)) return false;
  try {
    closeSync(openSync(lock, 'r+'));
    return false;
  } catch (e: any) {
    return e?.code === 'EBUSY' || e?.code === 'EPERM';
  }
}

function streamable(path: string, version: string): boolean {
  const [maj, min] = version.split('.').map(Number);
  if (!(maj > 6000 || (maj === 6000 && min >= 3))) return false;
  try {
    return readFileSync(join(path, 'Packages', 'manifest.json'), 'utf8').includes('"com.unity.inputsystem"');
  } catch {
    return false;
  }
}

/** Đã có package: junction Assets/PcPilot (link-project.ps1) hoặc dòng trong Packages/manifest.json (cách cho team). */
function isLinked(path: string): boolean {
  if (existsSync(join(path, 'Assets', 'PcPilot'))) return true;
  try {
    return readFileSync(join(path, 'Packages', 'manifest.json'), 'utf8').includes('"com.pcpilot.unity"');
  } catch {
    return false;
  }
}

// --- Danh sách (quét lại tối đa mỗi 30 giây; trạng thái mở đọc mỗi lần) ---------------------------
let cache: { at: number; list: Omit<ProjectInfo, 'open' | 'linked'>[] } = { at: 0, list: [] };

export function listProjects(roots: string[]): ProjectInfo[] {
  if (Date.now() - cache.at > 30_000) {
    const found = new Set<string>();
    for (const r of roots) scanRoot(r, 2, found);
    for (const p of hubProjects()) if (existsSync(join(p, 'ProjectSettings', 'ProjectVersion.txt'))) found.add(p);
    const seen = new Set<string>();
    const list: Omit<ProjectInfo, 'open' | 'linked'>[] = [];
    for (const p of found) {
      const key = normPath(p);
      if (seen.has(key)) continue;
      seen.add(key);
      const version = readVersion(p);
      if (!version) continue;
      list.push({ path: resolve(p), name: basename(p), version, editor: !!findEditor(version), streamable: streamable(p, version) });
    }
    cache = { at: Date.now(), list };
  }
  return cache.list
    .map((p) => ({ ...p, open: isOpen(p.path), linked: isLinked(p.path) }))
    .sort((a, b) => Number(b.open) - Number(a.open) || a.name.localeCompare(b.name));
}

export function findProject(roots: string[], path: string): ProjectInfo | undefined {
  const key = normPath(path);
  return listProjects(roots).find((p) => normPath(p.path) === key);
}

export const refreshProjects = () => (cache.at = 0);

// --- PowerShell ------------------------------------------------------------------------------------
async function ps(script: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out: (out + (code ? err : '')).trim() };
}

const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Gắn package PcPilot (junction Assets/PcPilot, không đổi gì trong git của project). */
export async function linkProject(path: string): Promise<string> {
  const script = resolve(import.meta.dir, '..', '..', '..', 'scripts', 'link-project.ps1');
  const r = await ps(`& ${psq(script)} -Project ${psq(path)}`);
  if (r.code) throw new Error(r.out || `link-project.ps1 lỗi (mã ${r.code})`);
  return r.out;
}

/**
 * Mở Unity qua WMI (Win32_Process.Create): Unity không thành tiến trình con của sidecar, nên khởi động lại sidecar
 * (hay dừng Scheduled Task, vốn tắt cả cây tiến trình) không tắt theo Unity.
 */
export async function launchEditor(exe: string, path: string): Promise<void> {
  const cmd = `"${exe}" -projectPath "${path}"`;
  const r = await ps(
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psq(cmd)}; CurrentDirectory = ${psq(dirname(exe))} }; $r.ReturnValue`,
  );
  if (r.code || r.out.split(/\s+/).pop() !== '0') throw new Error(`không chạy được Unity: ${r.out}`);
}

export interface EditorProc {
  pid: number;
  /** Tiêu đề cửa sổ chính: "<project> - <scene> - … - Unity …" khi đã mở xong, tên hộp thoại khi Unity đang hỏi. */
  title: string;
}

/** Tiến trình Unity Editor (không tính AssetImportWorker) theo project (khoá normPath). */
export async function editorProcs(): Promise<Map<string, EditorProc[]>> {
  const r = await ps(
    `Get-CimInstance Win32_Process -Filter "Name='Unity.exe'" | ForEach-Object { $t = (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).MainWindowTitle; "$($_.ProcessId)|$t|$($_.CommandLine)" }`,
  );
  const out = new Map<string, EditorProc[]>();
  for (const line of r.out.split(/\r?\n/)) {
    const [pid, title, ...rest] = line.split('|');
    const cl = rest.join('|');
    if (/-batchmode/i.test(cl)) continue;
    const m = /-projectpath\s+(?:"([^"]+)"|(\S+))/i.exec(cl);
    if (!m) continue;
    const key = normPath(m[1] ?? m[2]);
    out.set(key, [...(out.get(key) ?? []), { pid: Number(pid), title: title ?? '' }]);
  }
  return out;
}

async function editorPids(path: string): Promise<number[]> {
  return ((await editorProcs()).get(normPath(path)) ?? []).map((p) => p.pid);
}

export const hasEditor = async (path: string) => (await editorPids(path)).length > 0;

/**
 * Unity bị tắt ngang (buộc tắt, treo) để lại Temp/__Backupscenes: lần mở sau Unity bật hộp thoại "Recovering Scene
 * Backups" và đứng chờ, mở từ xa thì không ai bấm được. Chép bản sao lưu ra ngoài project rồi xoá, trả về chỗ đã cất.
 */
export function stashSceneBackups(path: string): string | null {
  const dir = join(path, 'Temp', '__Backupscenes');
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  if (!files.length) {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dest = join(process.env.LOCALAPPDATA ?? join(path, '..'), 'pcpilot', 'scene-backups', `${basename(path)}-${stamp}`);
  cpSync(dir, dest, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  return dest;
}

/** Tắt Unity không qua package PcPilot: đóng cửa sổ như bấm X (Unity có thể hỏi lưu scene), hoặc buộc tắt. */
export async function closeEditorWindow(path: string, force: boolean): Promise<number> {
  const pids = await editorPids(path);
  for (const pid of pids) {
    if (force) await ps(`taskkill /PID ${pid} /T /F`);
    else await ps(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`);
  }
  return pids.length;
}
