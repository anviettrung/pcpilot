// App Unity: chơi thử game trong Unity Editor. Hình không chụp từ màn hình mà do package Unity (unity/) chụp Game view
// rồi gửi khung RGBA qua TCP (link.ts); chạm từ điện thoại bơm vào Touchscreen ảo trong Unity. Thêm: danh sách project
// trên máy, mở/tắt Unity, Play/Stop, trả lời hộp thoại của Unity ngay trên điện thoại.
import { cfg, UNITY_PORT } from '../../core/config';
import type { App, Client, Host, StreamTarget, WS } from '../types';
import { UnityLink, type Editor } from './link';
import { WinHelper, isProgressTitle, type RawPopup } from './popups';
import {
  closeEditorWindow,
  editorProcs,
  findEditor,
  findProject,
  hasEditor,
  launchEditor,
  linkProject,
  listProjects,
  normPath,
  refreshProjects,
  stashSceneBackups,
} from './projects';

// Thư mục quét tìm project (unitypilot.json). Rỗng thì chỉ dùng các project Unity Hub đã biết.
const ROOTS = Array.isArray(cfg.projectRoots) ? cfg.projectRoots.filter((r) => typeof r === 'string' && r) : [];

interface Popup extends RawPopup {
  key: string;
  project: string;
  img: string;
}

export class UnityApp implements App {
  id = 'unity';
  name = 'Unity';
  private host!: Host;
  private link!: UnityLink;
  /** Project người xem chọn. Chưa chọn, hoặc project đã chọn đã tắt, thì xem Editor nối sau cùng. */
  private chosen = { key: '', path: '', name: '' };
  private opening = new Map<string, number>(); // khoá → lúc bấm Mở
  private closing = new Map<string, number>();
  private target: StreamTarget | null = null;
  // Hộp thoại của Unity: Unity dừng ở hộp thoại modal (khôi phục scene, lưu scene, Safe Mode...) thì gửi ảnh chụp và
  // danh sách nút lên trang, người dùng trả lời ngay trên điện thoại.
  private win = new WinHelper();
  private popups: Popup[] = [];
  private dialogs = new Map<string, string>(); // khoá project → tiêu đề hộp thoại đang chờ
  private pidKeys = new Map<number, string>(); // pid Unity → khoá project
  private lastPopups = '';
  private polling = false;
  private pollAgainAt = 0;
  private lastProjects = '';

  init(host: Host) {
    this.host = host;
    this.link = new UnityLink(UNITY_PORT, {
      onConnect: (ed) => {
        host.log(`Unity đã nối: ${ed.status?.project} (${ed.key})`);
        // Vừa mở project từ trang thì chuyển sang xem nó khi Unity nối xong. Nối lại sau domain reload (mỗi lần sửa
        // code) thì không: người xem có thể đang ở app khác (nếu có thêm app).
        if (this.opening.has(ed.key) && ed.key === this.chosen.key) host.activate(this.id);
        this.opening.delete(ed.key);
        this.apply();
        this.broadcastProjects();
      },
      onDisconnect: (ed) => {
        host.log(`Unity ngắt kết nối: ${ed.status?.project}`);
        this.apply();
        host.broadcastStatus();
        this.broadcastProjects();
      },
      onStatus: (ed) => {
        if (ed === this.activeEditor()) host.broadcastStatus();
      },
      onFrame: (ed, f) => {
        if (host.isActive(this.id) && ed === this.activeEditor()) host.pushRaw(f);
      },
    });
    setInterval(() => Date.now() >= this.pollAgainAt && void this.pollPopups(), 1500);
    setInterval(() => this.broadcastProjects(), 2000);
  }

  // --- Editor đang xem --------------------------------------------------------------------------------
  private chosenAlive(): boolean {
    const c = this.chosen;
    if (!c.key) return false;
    return this.link.isReloading(c.key) || this.opening.has(c.key) || (!!c.path && findProject(ROOTS, c.path)?.open === true);
  }

  private activeEditor(): Editor | undefined {
    if (this.chosen.key) {
      const e = this.link.get(this.chosen.key);
      if (e || this.chosenAlive()) return e;
    }
    return this.link.editors.at(-1);
  }

  stream(target: StreamTarget | null) {
    this.target = target;
    this.apply();
  }

  /** Chỉ Editor đang xem được chụp; các Editor khác thôi chụp. */
  private apply() {
    const t = this.target;
    const act = this.activeEditor();
    for (const ed of this.link.editors) {
      const on = !!t && ed === act;
      if (on) this.link.send(ed, { t: 'stream', on: true, fps: t!.fps, w: t!.w, h: t!.h });
      else if (ed.streamOn) this.link.send(ed, { t: 'stream', on: false });
      ed.streamOn = on;
    }
  }

  status() {
    const ed = this.activeEditor();
    const c = this.chosen;
    let state: Record<string, unknown>;
    if (ed?.status && (ed.status.quitting || this.closing.has(ed.key))) state = { ...ed.status, state: 'closing', key: ed.key };
    else if (ed?.status) state = { state: ed.status.compiling ? 'compiling' : 'ready', ...ed.status, key: ed.key };
    else if (c.key && this.closing.has(c.key)) state = { state: 'closing', project: c.name, key: c.key };
    else if (c.key && this.link.isReloading(c.key)) state = { state: 'reloading', project: c.name, key: c.key };
    else if (c.key && this.chosenAlive()) state = { state: 'starting', project: c.name, path: c.path, key: c.key, dialog: this.dialogs.get(c.key) ?? '' };
    else state = { state: 'offline' };
    return { ...state, editors: this.link.editors.length };
  }

  onOpen(ws: WS) {
    ws.send(JSON.stringify(this.projectsEvent()));
    if (this.lastPopups) ws.send(this.lastPopups);
  }

  onMessage(ws: WS, c: Client, m: any): boolean {
    switch (m.type) {
      case 'touch': {
        const ed = this.activeEditor();
        if (ed && this.host.isActive(this.id)) this.link.send(ed, { t: 'touch', seq: this.host.inputSeq(c, m.seq | 0), p: m.p });
        return true;
      }
      case 'cmd': {
        const ed = this.activeEditor();
        if (ed && ['play', 'stop', 'pause', 'scene', 'refresh'].includes(m.cmd)) this.link.send(ed, { t: m.cmd, name: m.name ?? '' });
        return true;
      }
      case 'select':
        this.select(String(m.path ?? ''));
        return true;
      case 'popup':
        void this.popupOp(ws, m).catch((e) => this.host.notice(ws, String(e?.message ?? e), true));
        return true;
      case 'project':
        void this.projectOp(ws, m);
        return true;
    }
    return false;
  }

  // --- Hộp thoại ----------------------------------------------------------------------------------
  private async pollPopups() {
    if (this.polling) return;
    this.polling = true;
    try {
      const r = await this.win.call('list');
      const raw = ((r?.list ?? []) as RawPopup[]).filter((p) => !isProgressTitle(p.title));
      // pid lạ: hỏi Windows một lần dòng lệnh của Unity để biết project.
      if (raw.some((p) => !this.pidKeys.has(p.pid))) {
        const procs = await editorProcs().catch(() => null);
        for (const [key, list] of procs ?? []) for (const pr of list) this.pidKeys.set(pr.pid, key);
        for (const p of raw) if (!this.pidKeys.has(p.pid)) this.pidKeys.set(p.pid, '');
      }
      const next: Popup[] = [];
      for (const p of raw) {
        const shot = await this.win.call('shot', { hwnd: p.hwnd, max: 900 }).catch(() => null);
        const key = this.pidKeys.get(p.pid) ?? '';
        const name = key ? (findProject(ROOTS, key)?.name ?? key.split('\\').pop() ?? '') : '';
        next.push({ ...p, buttons: p.buttons ?? [], key, project: name, img: shot?.png ? `data:image/png;base64,${shot.png}` : '' });
      }
      this.popups = next;
      this.dialogs.clear();
      for (const p of next) if (p.key) this.dialogs.set(p.key, p.title);
      const s = JSON.stringify({ type: 'popups', list: next });
      if (s !== this.lastPopups) {
        if (next.length && this.lastPopups.length < 60) this.host.log(`Unity đang hỏi: ${next.map((p) => `${p.project} "${p.title}"`).join(', ')}`);
        this.lastPopups = s;
        for (const ws of this.host.clients.keys()) ws.send(s);
        this.broadcastProjects();
      }
    } catch {
      // win-helper đang khởi động lại: lần sau thử tiếp
    } finally {
      this.polling = false;
    }
  }

  private async popupOp(ws: WS, m: any) {
    // Chỉ đụng tới hộp thoại đang có trong danh sách đã gửi lên trang.
    const p = this.popups.find((x) => x.hwnd === Number(m.hwnd));
    if (!p) return this.host.notice(ws, 'Hộp thoại này không còn nữa', true);
    let r: any;
    if (m.op === 'button') {
      const b = p.buttons.find((x) => x.hwnd === Number(m.button));
      if (!b) return this.host.notice(ws, 'Không thấy nút này', true);
      this.host.log(`trả lời hộp thoại "${p.title}" (${p.project}): ${b.text}`);
      r = await this.win.call('button', { hwnd: p.hwnd, button: b.hwnd });
    } else if (m.op === 'click') {
      const x = Math.round(Math.min(1, Math.max(0, Number(m.x))) * p.w);
      const y = Math.round(Math.min(1, Math.max(0, Number(m.y))) * p.h);
      this.host.log(`chạm vào hộp thoại "${p.title}" (${p.project}) tại ${x},${y}`);
      r = await this.win.call('click', { hwnd: p.hwnd, x, y });
    } else if (m.op === 'cancel') {
      this.host.log(`đóng hộp thoại "${p.title}" (${p.project})`);
      r = await this.win.call('cancel', { hwnd: p.hwnd });
    } else return;
    if (!r?.ok) this.host.notice(ws, `Không bấm được: ${r?.error ?? 'lỗi'}`, true);
    // Xem ngay kết quả (hộp thoại đóng, hay hiện hộp thoại khác).
    this.pollAgainAt = Date.now() + 1500;
    setTimeout(() => this.pollPopups(), 300);
    setTimeout(() => this.pollPopups(), 1000);
  }

  // --- Project ------------------------------------------------------------------------------------
  private projectsEvent() {
    const now = Date.now();
    const act = this.activeEditor();
    const list = listProjects(ROOTS).map((p) => {
      const key = normPath(p.path);
      const ed = this.link.get(key);
      if (this.opening.has(key) && now - this.opening.get(key)! > 5 * 60_000) this.opening.delete(key);
      if (this.closing.has(key) && (now - this.closing.get(key)! > 2 * 60_000 || (!p.open && !ed))) this.closing.delete(key);
      return {
        ...p,
        key,
        open: p.open || !!ed,
        bridged: !!ed,
        opening: this.opening.has(key),
        closing: this.closing.has(key),
        active: act ? act === ed : this.chosen.key === key,
        playing: !!ed?.status?.playing,
        dirty: !!ed?.status?.dirty,
        dialog: this.dialogs.get(key) ?? '',
        scene: ed?.status?.scene ?? '',
      };
    });
    return { type: 'projects', list };
  }

  private broadcastProjects(force = false) {
    const s = JSON.stringify(this.projectsEvent());
    if (s === this.lastProjects && !force) return;
    this.lastProjects = s;
    for (const ws of this.host.clients.keys()) ws.send(s);
  }

  private select(path: string) {
    const p = path ? findProject(ROOTS, path) : undefined;
    this.chosen = p ? { key: normPath(p.path), path: p.path, name: p.name } : { key: '', path: '', name: '' };
    if (p) this.host.activate(this.id);
    this.apply();
    this.host.broadcastStatus();
    this.broadcastProjects();
  }

  private async projectOp(ws: WS, m: any) {
    const host = this.host;
    if (m.op === 'rescan') {
      refreshProjects();
      return this.broadcastProjects(true);
    }
    // Chỉ đụng tới project có trong danh sách: không chạy Unity hay tắt tiến trình theo đường dẫn tuỳ ý.
    const p = findProject(ROOTS, String(m.path ?? ''));
    if (!p) return host.notice(ws, 'Không thấy project này trên máy', true);
    const key = normPath(p.path);
    const ed = this.link.get(key);
    try {
      if (m.op === 'open') {
        if (p.open || ed) return p.streamable ? this.select(p.path) : undefined;
        const exe = findEditor(p.version);
        if (!exe) return host.notice(ws, `Máy này chưa cài Unity ${p.version}`, true);
        // Unity đã chạy nhưng chưa khoá project (đang khởi động, hay kẹt ở hộp thoại): không mở thêm Unity thứ hai.
        if (await hasEditor(p.path)) {
          this.opening.set(key, this.opening.get(key) ?? Date.now());
          if (p.streamable) this.select(p.path);
          return host.notice(ws, `Unity đang khởi động ${p.name}. Nếu Unity hỏi gì, hộp thoại sẽ hiện trên trang để trả lời.`);
        }
        const stash = stashSceneBackups(p.path);
        if (stash) {
          host.log(`đã cất bản sao lưu scene của ${p.name} vào ${stash}`);
          host.notice(ws, `Unity lần trước bị tắt ngang, còn bản sao lưu scene. Đã cất vào ${stash} (Unity không hỏi khôi phục nữa).`);
        }
        if (p.streamable && !p.linked) {
          await linkProject(p.path);
          host.log(`đã gắn package UnityPilot vào ${p.path}`);
        }
        await launchEditor(exe, p.path);
        host.log(`mở Unity ${p.version}: ${p.path}`);
        this.opening.set(key, Date.now());
        this.closing.delete(key);
        // Project không stream được (Unity cũ, không có Input System) thì vẫn xem project hiện tại.
        if (p.streamable) this.select(p.path);
        else host.notice(ws, `Đã mở ${p.name}. Project này dùng Unity ${p.version} hoặc chưa có Input System nên không stream được.`);
      } else if (m.op === 'close') {
        // Package bản cũ (không gửi đường dẫn) chưa có lệnh quit: đóng cửa sổ thay vào đó.
        if (ed?.status?.path && !m.force) {
          // Unity tự thoát Play, lưu (hoặc bỏ) thay đổi trong scene rồi thoát. mode rỗng mà scene có thay đổi thì Unity không tắt.
          this.link.send(ed, { t: 'quit', name: m.mode === 'save' || m.mode === 'discard' ? m.mode : '' });
        } else {
          const n = await closeEditorWindow(p.path, !!m.force);
          if (!n) return host.notice(ws, `Không thấy Unity nào đang mở ${p.name}`, true);
          if (!m.force)
            host.notice(ws, `Đã đóng cửa sổ Unity (project chưa gắn package UnityPilot). Nếu Unity hỏi lưu scene, hộp thoại sẽ hiện trên trang để trả lời.`);
        }
        host.log(`tắt Unity${m.force ? ' (buộc)' : ''}: ${p.path}`);
        this.closing.set(key, Date.now());
        this.opening.delete(key);
      }
    } catch (e: any) {
      host.log(`project ${m.op} lỗi:`, e?.message ?? e);
      host.notice(ws, String(e?.message ?? e), true);
    }
    this.broadcastProjects(true);
  }
}
