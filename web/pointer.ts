// Chạm thành chuột cho remote màn hình (và chế độ chuột của game):
// - Chạm nhẹ = click trái tại chỗ chạm. Chạm rồi kéo = giữ chuột trái kéo. Giữ yên ~0,5 giây = click phải.
// - Hai ngón: chụm/mở = phóng to/thu nhỏ hình (ngay trên điện thoại, máy không biết); kéo hai ngón = cuộn (lúc
//   chưa phóng to) hoặc dời hình (lúc đã phóng to). Chạm nhẹ hai ngón = click phải.
// - Chế độ chuột tắt (game dùng bàn phím ảo): một ngón không làm gì, hai ngón vẫn phóng to được.
import { applyZoom, canvas, send, stage, videoPoint, zoom } from './core';

const LONG_MS = 500;
const MOVE_PX = 10;

interface P {
  x: number;
  y: number;
  x0: number;
  y0: number;
}
const pts = new Map<number, P>();
let mode: '' | 'tap' | 'drag' | 'long' | 'two' | 'pinch' | 'scroll' | 'done' = '';
let longTimer = 0;
let startAt = 0;
let two: { d0: number; cx: number; cy: number; k0: number; tx0: number; ty0: number; px: number; py: number; lastCx: number; lastCy: number } | null = null;
let wheelAcc = { x: 0, y: 0 };
let wheelRaf = 0;
let moveRaf = 0;
let movePending: { x: number; y: number } | null = null;
let buttonDown = false;
export const pointerState = { mouse: true };

const mouse = (a: string, p: { x: number; y: number }, d = 0) => send({ type: 'mouse', a, x: p.x, y: p.y, ...(d ? { d } : {}) });

function centroid() {
  const l = [...pts.values()];
  return { x: (l[0].x + l[1].x) / 2, y: (l[0].y + l[1].y) / 2, d: Math.hypot(l[0].x - l[1].x, l[0].y - l[1].y) };
}

function layout() {
  // Vị trí canvas khi chưa phóng to (transform-origin 0 0), theo toạ độ màn hình.
  const r = stage.getBoundingClientRect();
  return { x: r.left + canvas.offsetLeft, y: r.top + canvas.offsetTop };
}

function startTwo() {
  clearTimeout(longTimer);
  if (buttonDown) release();
  const c = centroid();
  const o = layout();
  two = {
    d0: Math.max(1, c.d), cx: c.x, cy: c.y, k0: zoom.k, tx0: zoom.x, ty0: zoom.y,
    // Điểm trên hình (pixel CSS chưa phóng) đang nằm dưới tâm hai ngón: giữ nó dưới tâm khi phóng.
    px: (c.x - o.x - zoom.x) / zoom.k, py: (c.y - o.y - zoom.y) / zoom.k, lastCx: c.x, lastCy: c.y,
  };
  mode = 'two';
}

function moveTwo() {
  if (!two) return;
  const c = centroid();
  if (mode === 'two') {
    if (Math.abs(c.d / two.d0 - 1) > 0.08) mode = 'pinch';
    else if (Math.hypot(c.x - two.cx, c.y - two.cy) > 12) mode = zoom.k > 1 ? 'pinch' : pointerState.mouse ? 'scroll' : 'pinch';
    else return;
  }
  if (mode === 'pinch') {
    const o = layout();
    zoom.k = Math.min(6, Math.max(1, (two.k0 * c.d) / two.d0));
    zoom.x = c.x - o.x - two.px * zoom.k;
    zoom.y = c.y - o.y - two.py * zoom.k;
    applyZoom();
  } else if (mode === 'scroll') {
    // Kéo lên = cuộn xuống (như màn hình cảm ứng). 1 px ≈ 4 đơn vị cuộn (120 = một nấc chuột).
    wheelAcc.x += c.x - two.lastCx;
    wheelAcc.y += c.y - two.lastCy;
    if (!wheelRaf) wheelRaf = requestAnimationFrame(flushWheel);
  }
  two.lastCx = c.x;
  two.lastCy = c.y;
}

function flushWheel() {
  wheelRaf = 0;
  if (!two) return;
  const p = videoPoint({ clientX: two.cx, clientY: two.cy });
  const dy = Math.round(wheelAcc.y * 4), dx = Math.round(-wheelAcc.x * 4);
  if (Math.abs(dy) >= 8) mouse('wheel', p, dy), (wheelAcc.y = 0);
  if (Math.abs(dx) >= 8) mouse('hwheel', p, dx), (wheelAcc.x = 0);
}

function release() {
  if (!buttonDown) return;
  buttonDown = false;
  const p = [...pts.values()][0];
  mouse('up', p ? videoPoint({ clientX: p.x, clientY: p.y }) : { x: 0.5, y: 0.5 });
}

function flushMove() {
  moveRaf = 0;
  if (movePending) mouse('move', movePending);
  movePending = null;
}

export function screenPointer(e: PointerEvent, ph: 'down' | 'move' | 'up' | 'cancel') {
  if (ph === 'down') {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    if (pts.size === 2 && (mode === 'tap' || mode === 'drag' || mode === '')) return startTwo();
    if (pts.size !== 1) return;
    startAt = performance.now();
    if (!pointerState.mouse) return void (mode = 'done');
    mode = 'tap';
    // Chưa gửi gì: ngón thứ hai có thể tới ngay sau (chụm phóng to), lúc đó không được dời chuột.
    const p = videoPoint(e);
    longTimer = window.setTimeout(() => {
      if (mode !== 'tap') return;
      mode = 'long';
      navigator.vibrate?.(15);
      mouse('move', p);
      mouse('rdown', p);
      mouse('rup', p);
    }, LONG_MS);
    return;
  }
  const pt = pts.get(e.pointerId);
  if (!pt) return;
  if (ph === 'move') {
    pt.x = e.clientX;
    pt.y = e.clientY;
    if (pts.size === 2) return moveTwo();
    if (mode === 'tap' && Math.hypot(pt.x - pt.x0, pt.y - pt.y0) > MOVE_PX) {
      clearTimeout(longTimer);
      mode = 'drag';
      buttonDown = true;
      const p0 = videoPoint({ clientX: pt.x0, clientY: pt.y0 });
      mouse('move', p0);
      mouse('down', p0);
    }
    if (mode === 'drag') {
      movePending = videoPoint(e);
      if (!moveRaf) moveRaf = requestAnimationFrame(flushMove);
    }
    return;
  }
  // up / cancel
  clearTimeout(longTimer);
  if (pts.size === 2 && mode === 'two' && ph === 'up' && performance.now() - startAt < 400 && pointerState.mouse) {
    const c = centroid();
    const p = videoPoint({ clientX: c.x, clientY: c.y });
    mouse('move', p);
    mouse('rdown', p);
    mouse('rup', p);
    mode = 'done';
  }
  if (mode === 'tap' && ph === 'up') {
    const p = videoPoint(e);
    mouse('move', p);
    mouse('down', p);
    mouse('up', p);
    mode = 'done';
  }
  if (mode === 'drag') {
    if (moveRaf) cancelAnimationFrame(moveRaf), (moveRaf = 0);
    movePending = null;
    pt.x = e.clientX;
    pt.y = e.clientY;
    release();
    mode = 'done';
  }
  pts.delete(e.pointerId);
  if (pts.size < 2) two = null;
  if (!pts.size) mode = '';
  else if (mode !== '') mode = 'done'; // còn một ngón sau khi phóng to: chờ nhấc nốt
}

/** Rời trang: nhả chuột đang giữ, quên các ngón. */
export function releasePointer() {
  clearTimeout(longTimer);
  release();
  pts.clear();
  two = null;
  mode = '';
}
