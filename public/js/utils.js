// utils.js — 공유 유틸리티

/**
 * panel(position:absolute)을 .auto-panel-handle 영역으로 드래그 이동 가능하게 함.
 * 부모(offsetParent) 영역 밖으로 나가지 않도록 클램핑.
 */
export function makeDraggable(panel) {
  if (!panel) return;
  const handle = panel.querySelector('.auto-panel-handle') || panel;
  let sx, sy, sl, st;

  function move(cx, cy) {
    const parent = panel.offsetParent;
    if (!parent) return;
    const maxL = parent.clientWidth  - panel.offsetWidth;
    const maxT = parent.clientHeight - panel.offsetHeight;
    panel.style.left = Math.max(0, Math.min(maxL, sl + cx - sx)) + 'px';
    panel.style.top  = Math.max(0, Math.min(maxT, st + cy - sy)) + 'px';
  }

  handle.addEventListener('mousedown', e => {
    if (e.target.closest('button,input,label,select')) return;
    sx = e.clientX; sy = e.clientY;
    sl = panel.offsetLeft; st = panel.offsetTop;
    const mm = e => move(e.clientX, e.clientY);
    const mu = () => { removeEventListener('mousemove', mm); removeEventListener('mouseup', mu); };
    addEventListener('mousemove', mm);
    addEventListener('mouseup', mu);
    e.preventDefault();
  });

  handle.addEventListener('touchstart', e => {
    if (e.target.closest('button,input,label,select')) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY;
    sl = panel.offsetLeft; st = panel.offsetTop;
    const tm = e => { e.preventDefault(); move(e.touches[0].clientX, e.touches[0].clientY); };
    const te = () => { handle.removeEventListener('touchmove', tm); handle.removeEventListener('touchend', te); };
    handle.addEventListener('touchmove', tm, { passive: false });
    handle.addEventListener('touchend', te);
  }, { passive: true });
}
