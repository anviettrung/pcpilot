// Danh sách app trên trang, cùng id với src/apps/index.ts. App đầu tiên là mặc định.
// App mới chụp theo cửa sổ (khai WindowApp trong src/apps/): thêm một screenApp({...}) ở đây, cùng id, rồi đưa vào
// WEB_APPS. Ví dụ một game chơi ngang có bàn phím ảo:
//   const myGame = screenApp({
//     id: 'mygame', icon: '<img src="/apps/mygame.png" alt="">', mouse: false, modeToggle: true, landscape: true,
//     pad: () => ({ v: 1, controls: [dpad(0.13, 0.7), k('Space', 0.92, 0.8, 'l', 'Nhảy'), k('Escape', 0.13, 0.1, 's')] }),
//     reasons: { offline: ['Game chưa mở', 'Mở game trên máy {m} (chế độ cửa sổ).'], minimized: ['Game đang thu nhỏ', 'Mở lại cửa sổ game trên máy {m}.'] },
//     label: () => 'My Game',
//   });
// (dpad, k lấy từ '../pad'.) Icon để ở web/public/apps/ và khai route trong src/main.ts.
import { $, actions, esc, prefs, savePrefs, send, toast, type WebApp } from '../core';
import { screenApp } from './screen';
import { unityApp } from './unity';

const ICON_SCREEN =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';

// --- Remote màn hình ----------------------------------------------------------------------------------
let windows: any[] = [];
function renderSources(a: any) {
  const t = a.target ?? {};
  const mons: any[] = a.monitors ?? [];
  const html = mons
    .map((m, i) => {
      const on = t.kind === 'monitor' && t.idx === i;
      return `<button type="button" data-mon="${i}" class="${on ? 'on' : ''}">Màn hình ${i + 1}<small>${m.w}×${m.h}${m.primary ? ' · chính' : ''}</small></button>`;
    })
    .join('') + (t.kind === 'window' ? `<button type="button" class="on" data-win="cur">Cửa sổ<small>${esc(t.title || '…')}</small></button>` : '');
  const box = $('monitorSeg');
  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
  }
}
function renderWindows() {
  const box = $('windowList');
  box.innerHTML = windows.length
    ? windows
        .map((w) => `<div class="proj" data-hwnd="${esc(w.hwnd)}"><span class="pdot"></span><div class="pinfo"><b>${esc(w.title)}</b><small>${w.minimized ? 'đang thu nhỏ' : `${w.w}×${w.h}`} · ${esc(w.cls)}</small></div></div>`)
        .join('')
    : '<div class="pempty">Không thấy cửa sổ nào</div>';
}

// --- Chế độ điện thoại: xoay màn hình máy theo điện thoại, chữ to hơn ------------------------------------
function setMobile(patch: Partial<typeof prefs.mobile>) {
  prefs.mobile = { ...prefs.mobile, ...patch };
  savePrefs();
  actions.sendView();
  actions.render();
}

function renderMobile(a: any) {
  const m = prefs.mobile;
  $<HTMLInputElement>('mobileOn').checked = m.on;
  $('mobileOpts').classList.toggle('off', !m.on);
  for (const b of $('rotateSeg').querySelectorAll<HTMLElement>('[data-v]')) b.classList.toggle('on', b.dataset.v === m.rotate);
  const d = a.display;
  const opts: number[] = (d?.options ?? [100, 125, 150, 175, 200]).filter((x: number) => x >= 125);
  const html = [`<button type="button" data-v="0" class="${m.scale ? '' : 'on'}">Như cũ</button>`]
    .concat(opts.map((x) => `<button type="button" data-v="${x}" class="${m.scale === x ? 'on' : ''}">${x}%</button>`))
    .join('');
  const box = $('scaleSeg');
  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
  }
  const now = d ? `Máy đang ${d.orientation % 2 ? 'dọc' : 'ngang'}, chữ ${d.scale}%` : '';
  const orig = d?.original ? ` (ban đầu ${d.original.orientation % 2 ? 'dọc' : 'ngang'}, ${d.original.scale}%)` : '';
  $('mobileNote').textContent =
    `${now}${orig}. Máy về như cũ khi tắt chế độ này, đổi sang app khác, hay không ai xem quá 1 phút.`;
}

const desktop = screenApp({
  id: 'desktop',
  icon: ICON_SCREEN,
  section: 'desktop',
  mouse: true,
  mobile: true,
  reasons: {
    gone: ['Cửa sổ đã đóng', 'Chọn cửa sổ khác hoặc xem cả màn hình.', 'Chọn nguồn'],
    minimized: ['Cửa sổ đang thu nhỏ', 'Mở lại cửa sổ trên máy {m}, hoặc chọn lại nó trong ☰ (sẽ tự mở lại).', 'Chọn nguồn'],
    offscreen: ['Cửa sổ nằm ngoài màn hình', 'Kéo cửa sổ vào trong màn hình.', 'Chọn nguồn'],
    monitor: ['Không xác định được màn hình', 'Chọn màn hình khác.', 'Chọn nguồn'],
  },
  label: (a) => (a.target?.kind === 'window' ? a.target.title || 'Cửa sổ' : `Màn hình ${(a.target?.idx ?? 0) + 1}`),
  sheet: (_st, a) => {
    renderSources(a);
    renderMobile(a);
  },
  init() {
    $('mobileBtn').onclick = () => {
      setMobile({ on: !prefs.mobile.on });
      toast(prefs.mobile.on ? 'Chế độ điện thoại: máy xoay theo điện thoại, chữ to hơn (☰ để chỉnh)' : 'Đã trả màn hình máy về như cũ');
    };
    $<HTMLInputElement>('mobileOn').onchange = (e) => setMobile({ on: (e.target as HTMLInputElement).checked });
    $('rotateSeg').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
      if (b) setMobile({ rotate: b.dataset.v as any, on: true });
    });
    $('scaleSeg').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
      if (b) setMobile({ scale: Number(b.dataset.v), on: true });
    });
    $('monitorSeg').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mon]');
      if (b) send({ type: 'desktop', op: 'monitor', idx: Number(b.dataset.mon) });
    });
    $('windowsBtn').onclick = () => {
      const box = $('windowList');
      box.hidden = !box.hidden;
      if (!box.hidden) {
        box.innerHTML = '<div class="pempty">Đang lấy danh sách…</div>';
        send({ type: 'desktop', op: 'windows' });
      }
    };
    $('windowList').addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-hwnd]');
      if (!el) return;
      send({ type: 'desktop', op: 'window', hwnd: el.dataset.hwnd });
      $('windowList').hidden = true;
    });
  },
  onJson(_l, m) {
    if (m.type !== 'windows') return false;
    windows = m.list ?? [];
    renderWindows();
    return true;
  },
});

export const WEB_APPS: WebApp[] = [desktop, unityApp];
