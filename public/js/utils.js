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

// ── 최소제곱 회귀 ────────────────────────────────────────
// 결정계수: 1 - SS_res / SS_tot (SS_tot=0이면 완전 적합으로 간주)
function _r2(ys, pred) {
  const mean = ys.reduce((s, v) => s + v, 0) / ys.length;
  let ssRes = 0, ssTot = 0;
  ys.forEach((y, i) => { ssRes += (y - pred[i]) ** 2; ssTot += (y - mean) ** 2; });
  return ssTot === 0 ? 1 : 1 - ssRes / ssTot;
}

/** y = a + b·x. 점 2개 미만이거나 x가 모두 같으면 null */
export function linearFit(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  if (sxx === 0) return null;
  const b = sxy / sxx, a = my - b * mx;
  return { a, b, r2: _r2(ys, xs.map(x => a + b * x)) };
}

/** y = c0 + c1·x + c2·x². 점 3개 미만이거나 행렬이 특이하면 null */
export function quadFit(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  // 정규방정식 3×3 — Σxᵏ, Σxᵏy
  const S = [0, 0, 0, 0, 0], T = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    let p = 1;
    for (let k = 0; k <= 4; k++) { S[k] += p; if (k <= 2) T[k] += p * ys[i]; p *= xs[i]; }
  }
  const M = [[S[0], S[1], S[2], T[0]], [S[1], S[2], S[3], T[1]], [S[2], S[3], S[4], T[2]]];
  // 가우스 소거 (부분 피벗)
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  const [c0, c1, c2] = [0, 1, 2].map(i => M[i][3] / M[i][i]);
  return { c0, c1, c2, r2: _r2(ys, xs.map(x => c0 + c1 * x + c2 * x * x)) };
}

/**
 * 포물선 운동 회귀: x-t 1차(vx), y-t 2차(가속도 a = 2·c2).
 * y는 화면 아래 방향이 + 이므로 낙하 시 a > 0.
 */
export function fitProjectile(data) {
  const ts = data.map(d => d.relTSec);
  const xf = linearFit(ts, data.map(d => d.relXCm));
  const yf = quadFit(ts, data.map(d => d.relYCm));
  return {
    n:    data.length,
    vx:   xf ? xf.b  : null,
    x0:   xf ? xf.a  : null,
    vxR2: xf ? xf.r2 : null,
    ay:   yf ? 2 * yf.c2 : null,
    vy0:  yf ? yf.c1 : null,
    y0:   yf ? yf.c0 : null,
    ayR2: yf ? yf.r2 : null,
  };
}
