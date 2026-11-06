// Giao diện app Unity: Play/Stop/Pause, chạm đa điểm gửi thẳng vào game, danh sách project trên mọi máy (mở, tắt),
// hộp thoại của Unity hiện lên điện thoại. Tự đo: ?autotest=<giây>&label=<tên>[&play=1][&scene=<tên>][&jpeg][&taps=0].
import {
  $, S, actions, allSamples, ask, canvas, esc, links, median, nextInputSeq, now, params, pct, r1, send, sendTo, sortedLinks, status,
  videoPoint, type Link, type WebApp,
} from '../core';

const playBtn = $<HTMLButtonElement>('playBtn');
const pauseBtn = $<HTMLButtonElement>('pauseBtn');
const cmd = (c: string, extra: object = {}) => send({ type: 'cmd', cmd: c, ...extra });

// Lệnh Play/Stop đang chờ Unity làm xong (Play có thể phải compile trước): hiện vòng quay thay vì im lặng.
let pending: { cmd: 'play' | 'stop'; at: number } | null = null;
function doPlayStop(c: 'play' | 'stop') {
  pending = { cmd: c, at: now() };
  cmd(c);
  actions.render();
}

// --- Chạm -----------------------------------------------------------------------------------------
const ids = new Map<number, number>(); // pointerId -> id nhỏ 0..9
const moves = new Map<number, { id: number; ph: string; x: number; y: number }>();
let moveRaf = 0;

function sendTouch(p: { id: number; ph: string; x: number; y: number }[]) {
  send({ type: 'touch', seq: nextInputSeq(), p });
}
function flushMoves() {
  moveRaf = 0;
  if (!moves.size) return;
  sendTouch([...moves.values()]);
  moves.clear();
}
function point(e: PointerEvent, ph: string) {
  let id = ids.get(e.pointerId);
  if (id === undefined) {
    const used = new Set(ids.values());
    id = 0;
    while (used.has(id)) id++;
    ids.set(e.pointerId, id);
  }
  return { id, ph, ...videoPoint(e) };
}

// --- Project trên các máy -------------------------------------------------------------------------
const projectsOf = (l: Link): any[] => l.data.projects ?? [];

function projectState(p: any): { text: string; cls: string; btn?: [string, string] } {
  const scene = p.scene ? ` · ${esc(p.scene)}` : '';
  if (p.dialog) return { text: `Unity đang hỏi "${esc(p.dialog)}": bấm vào đây để trả lời`, cls: 'busy warn', btn: ['force', 'Buộc tắt'] };
  if (p.closing) return { text: 'Đang tắt…', cls: 'busy', btn: ['force', 'Buộc tắt'] };
  if (p.bridged) return { text: (p.playing ? 'Đang Play' : 'Đang mở') + scene + (p.dirty ? ' · chưa lưu' : ''), cls: p.playing ? 'play' : 'open', btn: ['close', 'Tắt'] };
  if (p.open && p.opening && p.streamable) return { text: 'Unity đang tải project…', cls: 'busy', btn: ['close', 'Tắt'] };
  if (p.open) return { text: p.streamable ? 'Đang mở · chưa nối UnityPilot' : 'Đang mở · không stream được', cls: 'open dim', btn: ['close', 'Tắt'] };
  if (p.opening) return { text: 'Đang khởi động Unity…', cls: 'busy', btn: ['force', 'Buộc tắt'] };
  if (!p.editor) return { text: `Chưa cài Unity ${esc(p.version)}`, cls: 'off' };
  return { text: `Unity ${esc(p.version)}${p.streamable ? '' : ' · không stream'}`, cls: 'off', btn: ['open', 'Mở'] };
}

function renderProjects() {
  const box = $('projects');
  const html: string[] = [];
  for (const l of sortedLinks()) {
    const name = l.name || '…';
    const head = l === S.view ? 'đang xem' : l.open ? '' : 'không kết nối được';
    html.push(`<div class="mhead"><b>Máy ${esc(name)}</b><small>${head}</small></div>`);
    const list = projectsOf(l);
    if (!l.open && !list.length) continue;
    if (!l.data.projects) continue;
    if (!list.length) html.push('<div class="pempty">Không thấy project Unity nào</div>');
    const li = links.indexOf(l);
    for (const [pi, p] of list.entries()) {
      const st = projectState(p);
      const viewing = l === S.view && l.status?.app === 'unity' && p.active && (p.open || p.opening);
      const btn = st.btn && l.open ? `<button type="button" class="pbtn ${st.btn[0]}" data-l="${li}" data-p="${pi}" data-op="${st.btn[0]}">${st.btn[1]}</button>` : '';
      html.push(
        `<div class="proj ${st.cls}${viewing ? ' active' : ''}" data-l="${li}" data-p="${pi}"><span class="pdot"></span>` +
          `<div class="pinfo"><b>${esc(p.name)}</b>${viewing ? '<em>đang xem</em>' : ''}<small>${st.text}</small></div>${btn}</div>`,
      );
    }
  }
  const out = html.join('');
  if (box.dataset.html !== out) {
    box.dataset.html = out;
    box.innerHTML = out;
  }
}

/** Xem project này: chuyển sang máy của nó, chọn nó (sidecar tự chuyển máy đó sang app Unity). */
function view(l: Link, path: string) {
  actions.selectApp('unity', l);
  sendTo(l, { type: 'select', path });
  actions.switchView(l);
}

async function onProjectClick(e: Event) {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-p]');
  if (!el) return;
  const l = links[Number(el.dataset.l)];
  const p = l && projectsOf(l)[Number(el.dataset.p)];
  if (!l || !p) return;
  const op = el.dataset.op;
  if (op === 'open') {
    sendTo(l, { type: 'project', op: 'open', path: p.path });
    if (p.streamable) {
      view(l, p.path);
      actions.openSheet(false);
    }
  } else if (op === 'close') {
    let mode: string | null;
    if (p.bridged && p.dirty)
      mode = await ask(`Tắt ${p.name}?`, `Scene trên máy ${l.name} có thay đổi chưa lưu.`, [
        ['save', 'Lưu rồi tắt', 'primary'],
        ['discard', 'Bỏ thay đổi', 'danger'],
      ]);
    else if (p.bridged) mode = await ask(`Tắt ${p.name}?`, `Unity trên máy ${l.name}${p.playing ? ' sẽ Stop rồi' : ''} tắt.`, [['go', 'Tắt', 'danger']]);
    else
      mode = await ask(
        `Tắt ${p.name}?`,
        `Project chưa nối UnityPilot: sẽ đóng cửa sổ Unity như bấm X. Nếu Unity hỏi lưu scene, hộp thoại sẽ hiện ở đây để trả lời.`,
        [
          ['window', 'Đóng cửa sổ', 'primary'],
          ['force', 'Buộc tắt', 'danger'],
        ],
      );
    if (!mode) return;
    sendTo(l, { type: 'project', op: 'close', path: p.path, mode: mode === 'save' || mode === 'discard' ? mode : '', force: mode === 'force' });
  } else if (op === 'force') {
    if (await ask(`Buộc tắt ${p.name}?`, 'Thay đổi chưa lưu sẽ mất.', [['force', 'Buộc tắt', 'danger']]))
      sendTo(l, { type: 'project', op: 'close', path: p.path, force: true });
  } else if (p.dialog) {
    // Đã bấm "Để sau": bấm vào project thì hiện lại hộp thoại.
    // Hộp thoại chỉ hiện khi đang xem máy đó ở app Unity, nên chuyển sang xem trước.
    for (const k of [...later]) if (k.startsWith(`${l.url}|`)) later.delete(k);
    if (!unityViewed(l)) view(l, p.path);
    actions.openSheet(false);
    renderPopup();
  } else if ((p.bridged || p.opening || (p.open && p.streamable)) && !(l === S.view && l.status?.app === 'unity' && p.active)) {
    view(l, p.path);
    actions.openSheet(false);
  }
}

// --- Hộp thoại Unity trên máy -----------------------------------------------------------------------
// Sidecar gửi ảnh chụp và các nút của hộp thoại Unity đang chờ (khôi phục scene, lưu scene, Safe Mode...).
const later = new Set<string>(); // hộp thoại đã bấm "Để sau": `${url}|${hwnd}|${title}`
let shown: { l: Link; p: any } | null = null;
let popupBusyUntil = 0;
const popupKey = (l: Link, p: any) => `${l.url}|${p.hwnd}|${p.title}`;

// Chỉ hiện hộp thoại của máy đang xem, và chỉ khi máy đó đang ở app Unity: đang xem máy A thì hộp thoại Unity của
// máy B không chen lên. Muốn trả lời thì ☰ → bấm vào project đang hỏi (chuyển sang xem nó).
const unityViewed = (l: Link) => l === S.view && l.open && l.status?.app === 'unity';

function renderPopup() {
  let next: { l: Link; p: any } | null = null;
  const l0 = S.view;
  if (l0 && unityViewed(l0)) for (const p of l0.data.popups ?? []) if (!next && !later.has(popupKey(l0, p))) next = { l: l0, p };
  const box = $('popup');
  if (!next) {
    box.hidden = true;
    shown = null;
    return;
  }
  const same = shown && shown.l === next.l && shown.p.hwnd === next.p.hwnd;
  shown = next;
  const { l, p } = next;
  $('popupWhere').textContent = `Unity trên máy ${l.name}${p.project ? ` · ${p.project}` : ''} đang hỏi`;
  $('popupTitle').textContent = p.title || 'Hộp thoại';
  const img = $<HTMLImageElement>('popupImg');
  if (img.getAttribute('src') !== p.img) img.src = p.img;
  img.style.aspectRatio = `${p.w} / ${p.h}`;
  const sig = JSON.stringify(p.buttons);
  const row = $('popupButtons');
  if (!same || row.dataset.sig !== sig) {
    row.dataset.sig = sig;
    row.innerHTML = '';
    for (const b of p.buttons) {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = b.text;
      el.onclick = () => popupSend({ op: 'button', button: b.hwnd });
      row.append(el);
    }
  }
  const busy = now() < popupBusyUntil;
  img.classList.toggle('busy', busy);
  for (const b of box.querySelectorAll<HTMLButtonElement>('#popupButtons button, #popupCancel')) b.disabled = busy;
  box.hidden = false;
}

function popupSend(m: object) {
  if (!shown) return;
  sendTo(shown.l, { type: 'popup', hwnd: shown.p.hwnd, ...m });
  // Chờ sidecar chụp lại (hộp thoại đóng hay đổi) rồi mới cho bấm tiếp, khỏi bấm hai lần.
  popupBusyUntil = now() + 1500;
  renderPopup();
  setTimeout(renderPopup, 1600);
}

// --- Tự đo (?autotest=giây) -----------------------------------------------------------------------
// Tự chạm giả lập (gửi thẳng lệnh chạm, không qua sự kiện DOM), đo độ trễ, gửi kết quả và ảnh chụp về sidecar.
async function autotest(seconds: number) {
  const label = params.get('label') ?? 'autotest';
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const u = () => status()?.apps?.unity;
  while (!u()?.project) await sleep(200);
  if (params.get('scene') && u().scene !== params.get('scene')) {
    if (u().playing) cmd('stop');
    await sleep(1500);
    cmd('scene', { name: params.get('scene') });
    await sleep(2000);
  }
  if (params.get('play') && !u().playing) cmd('play');
  while (!S.drawn) await sleep(200);
  await sleep(1500);
  for (const k of Object.keys(allSamples) as (keyof typeof allSamples)[]) allSamples[k] = [];
  const s0 = actions.stats(), t0 = now();
  const end = t0 + seconds * 1000;
  let i = 0;
  let shot = false;
  while (now() < end) {
    const x = 0.2 + Math.random() * 0.6, y = 0.3 + Math.random() * 0.35;
    if (params.get('taps') === '0') {
      // chỉ xem, không chạm (project thật: chạm bừa có thể đổi dữ liệu lưu)
    } else if (i % 3 === 2) {
      sendTouch([{ id: 0, ph: 'down', x, y }]);
      for (let k = 1; k <= 10; k++) {
        await sleep(16);
        sendTouch([{ id: 0, ph: 'move', x: x + k * 0.015, y }]);
      }
      sendTouch([{ id: 0, ph: 'up', x: x + 0.15, y }]);
    } else {
      sendTouch([{ id: 0, ph: 'down', x, y }]);
      await sleep(80);
      sendTouch([{ id: 0, ph: 'up', x, y }]);
    }
    i++;
    await sleep(500);
    if (!shot && now() > t0 + seconds * 500) {
      shot = true;
      send({ type: 'snapshot', name: label, png: canvas.toDataURL('image/png') });
    }
  }
  const dur = (now() - t0) / 1000;
  const s1 = actions.stats();
  const st = (a: number[]) => ({ n: a.length, median: r1(median(a)), p90: r1(pct(a, 0.9)), max: r1(Math.max(...a)) });
  const data = {
    label,
    seconds: +dur.toFixed(1),
    scene: u().scene,
    size: s1.size,
    codec: s1.codec,
    recvFps: +((s1.frameCount - s0.frameCount) / dur).toFixed(1),
    drawnFps: +((s1.drawn - s0.drawn) / dur).toFixed(1),
    kbps: Math.round(((s1.bytes - s0.bytes) * 8) / dur / 1000),
    videoLatency: st(allSamples.video),
    inputLatency: st(allSamples.input),
    decode: st(allSamples.decode),
    net: st(allSamples.net),
    rtt: st(allSamples.rtt),
    keyframes: s1.keyCount,
  };
  send({ type: 'report', data });
  document.title = 'DONE ' + JSON.stringify(data);
}

export const unityApp: WebApp = {
  id: 'unity',
  group: 'unity',
  section: 'unity',
  icon: '<img src="/apps/unity.png" alt="">',

  init() {
    playBtn.onclick = () => doPlayStop(status()?.apps?.unity?.playing ? 'stop' : 'play');
    $('overlayPlay').onclick = () => doPlayStop('play');
    pauseBtn.onclick = () => cmd('pause');
    $('projects').addEventListener('click', onProjectClick);
    $('rescanBtn').onclick = () => {
      for (const l of links) sendTo(l, { type: 'project', op: 'rescan' });
    };
    $('popupImg').addEventListener('click', (e) => {
      const img = e.currentTarget as HTMLImageElement;
      const r = img.getBoundingClientRect();
      const mark = document.createElement('div');
      mark.className = 'tap-mark';
      mark.style.left = `${e.clientX}px`;
      mark.style.top = `${e.clientY}px`;
      document.body.append(mark);
      setTimeout(() => mark.remove(), 700);
      popupSend({ op: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
    });
    $('popupCancel').onclick = () => popupSend({ op: 'cancel' });
    $('popupLater').onclick = () => {
      if (shown) later.add(popupKey(shown.l, shown.p));
      renderPopup();
    };
    // Đổi máy đang xem hay đổi app thì hộp thoại hiện/ẩn theo (render chung chỉ gọi app đang xem).
    setInterval(renderPopup, 500);
    const at = Number(params.get('autotest'));
    if (at > 0) void autotest(at);
  },

  onJson(l, m) {
    if (m.type === 'projects') {
      l.data.projects = m.list ?? [];
      if (!$('sheet').hidden) renderProjects();
      return true;
    }
    if (m.type === 'popups') {
      l.data.popups = m.list ?? [];
      renderPopup();
      return true;
    }
    if (m.type === 'closed') {
      l.data.popups = [];
      renderPopup();
    }
    return false;
  },

  label: (u) => u.project ?? 'Unity',

  overlay(st, u) {
    const machine = st.machine;
    const playing = !!u.playing;
    if (pending && ((pending.cmd === 'play') === playing || now() - pending.at > 60000)) pending = null;
    if (u.state === 'offline') return { title: 'Unity chưa mở', text: `Chọn project để mở trên máy ${machine} hoặc máy khác.`, pick: 'Chọn project' };
    if (u.state === 'closing') return { title: `Đang tắt ${u.project}…`, text: `Máy ${machine}`, spin: true };
    if (u.state === 'starting' && u.dialog)
      return { title: `Unity đang hỏi "${u.dialog}"`, text: 'Trả lời trong hộp hiện lên (☰ → bấm vào project nếu đã đóng).', pick: 'Chọn project' };
    if (u.state === 'starting') return { title: `Đang mở ${u.project}…`, text: `Máy ${machine}. Lần đầu mở project có thể mất vài phút.`, spin: true };
    if (u.state === 'reloading' || u.state === 'compiling' || u.reloading)
      return { title: 'Unity đang compile…', text: pending?.cmd === 'play' ? 'Compile xong sẽ tự vào Play.' : '', spin: true };
    if (pending?.cmd === 'play' && !playing) return { title: 'Đang vào Play…', text: `${u.project} · ${u.scene}`, spin: true };
    if (!playing) return { title: u.project, text: `${u.scene} · chưa Play`, play: true };
    return null;
  },

  live: (_st, u) => !!u.playing,

  render(_st, u) {
    const playing = !!u.playing;
    playBtn.classList.toggle('playing', playing);
    playBtn.classList.toggle('pending', !!pending);
    playBtn.setAttribute('aria-label', playing ? 'Stop' : 'Play');
    playBtn.disabled = !S.view?.open || !u.state || ['offline', 'starting', 'closing'].includes(u.state);
    pauseBtn.hidden = !playing;
    pauseBtn.classList.toggle('on', !!u.paused);
    $('pausedBadge').hidden = !(playing && u.paused);
  },

  sheet() {
    renderProjects();
  },

  info: (u) => (u.unity ? `${u.scene} · Unity ${u.unity} · ${u.platform}` : u.project ? 'đang mở…' : 'Unity chưa mở'),

  metrics: (st) => [['Máy chủ', `chụp ${st.stream.capToRecvMs} · encode ${st.stream.recvToEncMs} ms`]],

  pointer(e, ph) {
    if (ph === 'down') {
      flushMoves();
      sendTouch([point(e, 'down')]);
    } else if (ph === 'move') {
      if (!ids.has(e.pointerId)) return;
      const p = point(e, 'move');
      moves.set(p.id, p);
      if (!moveRaf) moveRaf = requestAnimationFrame(flushMoves);
    } else {
      if (!ids.has(e.pointerId)) return;
      flushMoves();
      sendTouch([point(e, ph)]);
      ids.delete(e.pointerId);
    }
  },

  releaseAll() {
    for (const [pid, id] of ids) sendTouch([{ id, ph: 'cancel', x: 0.5, y: 0.5 }]), ids.delete(pid);
  },
};
