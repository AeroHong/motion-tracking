// slitAnalyzer.js — 이중슬릿 간섭무늬 분석 모드
// 수평으로 펼쳐진 간섭무늬(세로 밝은 줄)를 수평 스캔선으로 피크 감지 → Δy 측정

import { Calibration }    from './calibration.js';
import { ZoomController } from './zoomController.js';

const $ = id => document.getElementById(id);

// ── 상태 ──────────────────────────────────────────────────
const st = {
  mode:           'pan',    // 'calibration' | 'add' | 'pan'
  imgEl:          null,
  scanY:          0,        // 스캔선 Y 위치 (캔버스 픽셀)
  isDraggingScan: false,
  calibDragIdx:   -1,
  panStart:       null,
  fringes:        [],       // [{xPx}] 오름차순 (캔버스 픽셀)
  centerIdx:      -1,       // m=0 무늬 인덱스
  selectedIdx:    -1,
  sensitivity:    25,       // 피크 최소 prominence (brightness 0-255 단위)
  minSpacing:     20,       // 무늬 최소 간격 (캔버스 px)
};

let _downClientX = 0, _downClientY = 0;
let canvas, ctx, calib, zoom, _show;

// ── 초기화 ────────────────────────────────────────────────
export function initSlitAnalyzer(showScreen) {
  _show  = showScreen;
  canvas = $('slit-canvas');
  ctx    = canvas.getContext('2d');
  calib  = new Calibration();
  zoom   = new ZoomController(canvas, {
    onDown: _onDown,
    onMove: _onMove,
    onUp:   _onUp,
  });
  _bindUpload();
  _bindControls();
}

function _enterAnalyze() {
  // 화면이 DOM에 렌더된 후 크기 계산
  requestAnimationFrame(() => {
    _fitCanvas();
    zoom.reset();
    calib.reset();
    st.fringes     = [];
    st.centerIdx   = -1;
    st.selectedIdx = -1;
    _setMode('pan');
    _render();
    _updateFringeList();
    _updateResults();
  });
}

// ── 업로드 ────────────────────────────────────────────────
function _bindUpload() {
  $('slit-file-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) _loadImage(f);
    e.target.value = '';
  });
  $('slit-local-btn').addEventListener('click',    () => $('slit-file-input').click());
  $('btn-slit-start').addEventListener('click',    () => {
    if (!st.imgEl) return;
    _show('slit-analyze');
    _enterAnalyze();
  });
  $('btn-slit-back').addEventListener('click',     () => _show('mode'));
  $('btn-slit-back2').addEventListener('click',    () => _show('mode'));
  $('btn-slit-reupload').addEventListener('click', () => _show('slit-upload'));
}

function _loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    st.imgEl = img;
    $('slit-preview').src = url;
    $('slit-preview').classList.remove('hidden');
    $('slit-filename').textContent = `✓ ${file.name}`;
    $('btn-slit-start').disabled = false;
  };
  img.src = url;
}

// ── 캔버스 크기 조정 ──────────────────────────────────────
function _fitCanvas() {
  const wrap  = $('slit-canvas-wrap');
  const maxW  = (wrap?.clientWidth  || 700) - 16;
  const maxH  = Math.round(window.innerHeight * 0.88);
  const img   = st.imgEl;
  const ratio = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
  canvas.width  = Math.round(img.naturalWidth  * ratio);
  canvas.height = Math.round(img.naturalHeight * ratio);
  canvas.style.width  = canvas.width  + 'px';
  canvas.style.height = canvas.height + 'px';
  st.scanY = Math.round(canvas.height / 2);
}

// ── 컨트롤 바인딩 ────────────────────────────────────────
function _bindControls() {
  $('slit-btn-pan').addEventListener('click',         () => _setMode('pan'));
  $('slit-btn-calibration').addEventListener('click', () => _setMode('calibration'));
  $('slit-btn-add').addEventListener('click',         () => _setMode('add'));
  $('slit-btn-detect').addEventListener('click',      _autoDetect);

  $('slit-btn-clear').addEventListener('click', () => {
    st.fringes = []; st.centerIdx = -1; st.selectedIdx = -1;
    _render(); _updateFringeList(); _updateResults();
  });

  $('slit-calib-ok').addEventListener('click', _applyCalib);
  $('slit-calib-value').addEventListener('keydown', e => { if (e.key === 'Enter') _applyCalib(); });

  $('slit-sensitivity').addEventListener('input', e => {
    st.sensitivity = +e.target.value;
    $('slit-sensitivity-val').textContent = e.target.value;
  });
  $('slit-min-spacing').addEventListener('input', e => {
    st.minSpacing = +e.target.value;
    $('slit-min-spacing-val').textContent = e.target.value;
  });
}

function _setMode(mode) {
  st.mode = mode;
  ['pan', 'calibration', 'add'].forEach(m =>
    $(`slit-btn-${m}`)?.classList.toggle('active', m === mode)
  );
  const hints = {
    pan:         '핀치/휠로 확대 · 드래그로 이동',
    calibration: '자(ruler)의 두 점 클릭 → 실제 길이 입력',
    add:         '밝은 무늬 중심을 클릭하여 추가',
  };
  $('slit-mode-hint').textContent = hints[mode] || '';

  const panel = $('slit-calib-panel');
  if (mode === 'calibration' && calib.points.length === 2) panel.classList.remove('hidden');
  else if (mode !== 'calibration')                          panel.classList.add('hidden');
}

function _applyCalib() {
  const v = parseFloat($('slit-calib-value').value);
  if (isNaN(v) || v <= 0) return;
  if (!calib.setRealLength(v)) return;
  $('slit-calib-panel').classList.add('hidden');
  _setMode('pan');
  _render(); _updateFringeList(); _updateResults();
}

// ── 자동 감지 ────────────────────────────────────────────
function _autoDetect() {
  if (!st.imgEl) return;

  // CSS transform 영향 없이 원본 픽셀 읽기 위해 오프스크린 캔버스 사용
  const oc   = document.createElement('canvas');
  oc.width   = canvas.width;
  oc.height  = canvas.height;
  oc.getContext('2d').drawImage(st.imgEl, 0, 0, canvas.width, canvas.height);

  const scanY = Math.max(2, Math.min(canvas.height - 3, Math.round(st.scanY)));
  const rows  = Math.min(5, canvas.height - scanY + 2);
  const d     = oc.getContext('2d').getImageData(0, scanY - 2, canvas.width, rows).data;
  const n     = canvas.width;
  const bright = new Float32Array(n);

  // 인접 5행 평균 밝기 (luminance)
  for (let x = 0; x < n; x++) {
    let sum = 0;
    for (let r = 0; r < rows; r++) {
      const i = (r * n + x) * 4;
      sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    }
    bright[x] = sum / rows;
  }

  const sigma    = Math.max(1.5, st.minSpacing / 5);
  const smoothed = _gaussSmooth(bright, sigma);
  const peaks    = _findPeaks(smoothed, st.sensitivity, st.minSpacing);

  if (peaks.length === 0) {
    alert('무늬를 감지하지 못했습니다.\n' +
          '노란 스캔선을 밝은 무늬 위에 놓고,\n' +
          '감도(Prominence)를 낮춰 다시 시도하세요.');
    return;
  }

  st.fringes     = peaks.map(x => ({ xPx: x }));
  st.centerIdx   = -1;
  st.selectedIdx = -1;
  _render(); _updateFringeList(); _updateResults();
}

function _gaussSmooth(arr, sigma) {
  const half = Math.ceil(sigma * 3);
  const size = half * 2 + 1;
  const k    = new Float32Array(size);
  let   ksum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - half;
    k[i] = Math.exp(-x * x / (2 * sigma * sigma));
    ksum += k[i];
  }
  for (let i = 0; i < size; i++) k[i] /= ksum;

  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0;
    for (let j = -half; j <= half; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < arr.length) s += arr[idx] * k[j + half];
    }
    out[i] = s;
  }
  return out;
}

// prominence 기반 피크 탐색 — 어둡고 밝은 패턴 모두 대응
function _findPeaks(arr, minProm, minSp) {
  const n = arr.length, peaks = [];
  for (let x = 1; x < n - 1; x++) {
    if (arr[x] <= arr[x - 1] || arr[x] < arr[x + 1]) continue;
    const lo = Math.max(0, x - minSp);
    const hi = Math.min(n, x + minSp + 1);
    let base = Infinity;
    for (let j = lo; j < hi; j++) if (j !== x && arr[j] < base) base = arr[j];
    if (arr[x] - (base === Infinity ? 0 : base) < minProm) continue;
    if (peaks.length > 0 && x - peaks[peaks.length - 1] < minSp) {
      if (arr[x] > arr[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = x;
    } else {
      peaks.push(x);
    }
  }
  return peaks;
}

// ── 캔버스 좌표 변환 ─────────────────────────────────────
function _toCanvas(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * canvas.width  / rect.width,
    y: (e.clientY - rect.top)  * canvas.height / rect.height,
  };
}

// ── 캔버스 이벤트 (ZoomController 콜백) ──────────────────
function _onDown(e) {
  _downClientX = e.clientX;
  _downClientY = e.clientY;
  const { x, y } = _toCanvas(e);

  // 스캔선 핸들 드래그
  if (Math.abs(y - st.scanY) < 16) { st.isDraggingScan = true; return; }

  // 보정 점 드래그
  if (st.mode === 'calibration') {
    const idx = calib.findPointNear(x, y);
    if (idx >= 0) { st.calibDragIdx = idx; return; }
  }

  if (st.mode === 'pan') st.panStart = { clientX: e.clientX, clientY: e.clientY };
}

function _onMove(e) {
  if (st.isDraggingScan) {
    st.scanY = Math.max(2, Math.min(canvas.height - 2, _toCanvas(e).y));
    _render(); return;
  }
  if (st.calibDragIdx >= 0) {
    const { x, y } = _toCanvas(e);
    calib.movePoint(st.calibDragIdx, x, y);
    if (calib.isCalibrated) calib.setRealLength(calib.realLengthCm);
    _render(); _updateResults(); return;
  }
  if (st.mode === 'pan' && st.panStart) {
    zoom.pan(e.clientX - st.panStart.clientX, e.clientY - st.panStart.clientY);
    st.panStart = { clientX: e.clientX, clientY: e.clientY };
  }
}

function _onUp(e) {
  const dx      = Math.abs(e.clientX - _downClientX);
  const dy      = Math.abs(e.clientY - _downClientY);
  const wasDrag = st.isDraggingScan || (st.calibDragIdx >= 0) || dx > 6 || dy > 6;

  st.isDraggingScan = false;
  st.calibDragIdx   = -1;
  st.panStart       = null;
  if (wasDrag) return;

  const { x, y } = _toCanvas(e);
  if (Math.abs(y - st.scanY) < 16) return;

  // 보정 버튼 탭 (어느 모드에서나)
  if (calib.points.length === 2 && calib.isOnButton(x, y)) {
    $('slit-calib-panel').classList.remove('hidden');
    $('slit-calib-value').focus();
    return;
  }

  if (st.mode === 'calibration') {
    if (calib.addPoint(x, y)) {
      if (calib.points.length === 2) {
        $('slit-calib-panel').classList.remove('hidden');
        $('slit-calib-value').focus();
      }
      _render();
    }
    return;
  }

  if (st.mode === 'add') {
    const nearIdx = _nearFringe(x);
    if (nearIdx >= 0 && Math.abs(st.fringes[nearIdx].xPx - x) < 14) {
      st.selectedIdx = nearIdx;
    } else {
      _addFringe(x);
    }
    _render(); _updateFringeList(); return;
  }

  // pan 모드: 무늬 클릭 → 선택
  const nearIdx = _nearFringe(x);
  if (nearIdx >= 0 && Math.abs(st.fringes[nearIdx].xPx - x) < 14) {
    st.selectedIdx = nearIdx;
    _render(); _updateFringeList();
  }
}

// ── 무늬 관리 ────────────────────────────────────────────
function _addFringe(xPx) {
  if (st.fringes.some(f => Math.abs(f.xPx - xPx) < st.minSpacing)) return;
  const centerXPx = st.centerIdx >= 0 ? st.fringes[st.centerIdx].xPx : null;
  st.fringes.push({ xPx });
  st.fringes.sort((a, b) => a.xPx - b.xPx);
  if (centerXPx !== null) st.centerIdx = st.fringes.findIndex(f => f.xPx === centerXPx);
  st.selectedIdx = st.fringes.findIndex(f => Math.abs(f.xPx - xPx) < 1);
  _updateResults();
}

function _deleteFringe(idx) {
  if (idx < 0 || idx >= st.fringes.length) return;
  const wasCenter = idx === st.centerIdx;
  st.fringes.splice(idx, 1);
  if (wasCenter) st.centerIdx = -1;
  else if (st.centerIdx > idx) st.centerIdx--;
  st.selectedIdx = -1;
  _render(); _updateFringeList(); _updateResults();
}

function _setCenter(idx) {
  st.centerIdx = idx;
  _render(); _updateFringeList(); _updateResults();
}

function _nearFringe(x) {
  let best = -1, bestD = Infinity;
  st.fringes.forEach((f, i) => {
    const d = Math.abs(f.xPx - x);
    if (d < bestD) { bestD = d; best = i; }
  });
  return bestD < 20 ? best : -1;
}

function _getOrder(idx) {
  return st.centerIdx < 0 ? null : idx - st.centerIdx;
}

// ── 렌더링 ───────────────────────────────────────────────
function _render() {
  if (!st.imgEl) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(st.imgEl, 0, 0, canvas.width, canvas.height);
  _drawScanLine();
  calib.draw(ctx);
  _drawFringes();
}

function _drawScanLine() {
  const y = Math.round(st.scanY);
  ctx.save();
  ctx.setLineDash([7, 5]);
  ctx.strokeStyle = 'rgba(255,210,0,0.9)';
  ctx.lineWidth   = 2;
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  ctx.setLineDash([]);

  const hx = canvas.width - 18;
  ctx.fillStyle = 'rgba(255,210,0,0.9)';
  ctx.beginPath(); ctx.arc(hx, y, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#000';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('↕', hx, y);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

function _drawFringes() {
  st.fringes.forEach((f, i) => {
    const isCenter   = i === st.centerIdx;
    const isSelected = i === st.selectedIdx;
    const order      = _getOrder(i);
    const color      = isCenter   ? '#ff6b35'
                     : isSelected ? '#00e5ff'
                     : 'rgba(120,220,255,0.8)';

    ctx.save();
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = color;
    ctx.lineWidth   = (isCenter || isSelected) ? 2.5 : 1.5;
    ctx.beginPath(); ctx.moveTo(f.xPx, 0); ctx.lineTo(f.xPx, canvas.height); ctx.stroke();
    ctx.setLineDash([]);

    const label = order !== null
      ? (order === 0 ? 'm=0' : `m=${order > 0 ? '+' : ''}${order}`)
      : `${i + 1}`;
    const tw = Math.max(32, label.length * 8 + 8);
    const tx = Math.max(1, Math.min(canvas.width - tw - 1, f.xPx - tw / 2));
    const ty = isCenter ? 32 : 14;

    ctx.fillStyle = isCenter ? 'rgba(255,107,53,0.9)' : 'rgba(10,35,60,0.85)';
    _rrect(ctx, tx, ty - 12, tw, 18, 4); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center'; ctx.fillText(label, tx + tw / 2, ty);
    ctx.textAlign = 'left';
    ctx.restore();
  });
}

function _rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── 사이드바 업데이트 ─────────────────────────────────────
function _updateFringeList() {
  const list  = $('slit-fringe-list');
  const count = $('slit-fringe-count');
  if (count) count.textContent = st.fringes.length ? `(${st.fringes.length})` : '';
  if (!list) return;

  if (st.fringes.length === 0) {
    list.innerHTML = '<div class="slit-empty-msg">자동 감지 또는<br>➕ 추가 모드로 클릭하여 무늬를 추가하세요.</div>';
    return;
  }

  const refX = st.centerIdx >= 0 ? st.fringes[st.centerIdx].xPx : st.fringes[0].xPx;

  list.innerHTML = st.fringes.map((f, i) => {
    const order    = _getOrder(i);
    const isCenter = i === st.centerIdx;
    const isSel    = i === st.selectedIdx;
    const dx       = f.xPx - refX;
    const absDx    = Math.abs(dx);
    const sign     = dx > 0 ? '+' : dx < 0 ? '−' : '';
    const posStr   = calib.isCalibrated
      ? `${sign}${calib.toCm(absDx).toFixed(2)} cm`
      : `${sign}${Math.round(absDx)} px`;
    const lbl      = order !== null
      ? (order === 0 ? 'm = 0' : `m = ${order > 0 ? '+' : ''}${order}`)
      : `무늬 ${i + 1}`;

    return `<div class="slit-fringe-item${isSel ? ' selected' : ''}${isCenter ? ' center' : ''}" data-idx="${i}">
      <div class="slit-fringe-label${isCenter ? ' center-label' : ''}">${lbl}</div>
      <div class="slit-fringe-pos">${posStr}</div>
      <div class="slit-fringe-btns">
        <button class="slit-center-btn${isCenter ? ' active' : ''}" data-action="center" data-idx="${i}" title="중앙(m=0)으로 설정">⭕</button>
        <button class="slit-del-btn" data-action="delete" data-idx="${i}" title="삭제">✕</button>
      </div>
    </div>`;
  }).join('');

  list.onclick = e => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      const idx = +btn.dataset.idx;
      if (btn.dataset.action === 'center') _setCenter(idx);
      if (btn.dataset.action === 'delete') _deleteFringe(idx);
      return;
    }
    const item = e.target.closest('.slit-fringe-item');
    if (item) { st.selectedIdx = +item.dataset.idx; _render(); _updateFringeList(); }
  };
}

function _updateResults() {
  const el = $('slit-results');
  if (!el) return;

  if (st.fringes.length < 2) {
    el.innerHTML = '<div class="slit-empty-msg">무늬 2개 이상 필요합니다.</div>';
    return;
  }

  const toU = px => calib.isCalibrated
    ? `${calib.toCm(px).toFixed(3)} cm`
    : `${Math.round(px)} px`;

  const spacings = [];
  for (let i = 1; i < st.fringes.length; i++) {
    spacings.push(st.fringes[i].xPx - st.fringes[i - 1].xPx);
  }
  const avg = spacings.reduce((a, b) => a + b, 0) / spacings.length;
  const std = spacings.length > 1
    ? Math.sqrt(spacings.map(s => (s - avg) ** 2).reduce((a, b) => a + b, 0) / (spacings.length - 1))
    : 0;

  const rows = spacings.map((s, i) => {
    const o1  = _getOrder(i), o2 = _getOrder(i + 1);
    const lbl = o1 !== null && o2 !== null
      ? `m=${o1 > 0 ? '+' : ''}${o1}→${o2 > 0 ? '+' : ''}${o2}`
      : `${i + 1}→${i + 2}번`;
    return `<tr><td>${lbl}</td><td>${toU(s)}</td></tr>`;
  }).join('');

  el.innerHTML = `
    <table class="slit-table">
      <thead><tr><th>구간</th><th>간격 Δy</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="slit-avg-box">
      <span>평균 Δy</span>
      <strong>${toU(avg)}</strong>
      ${spacings.length > 1 ? `<span class="slit-std">± ${toU(std)}</span>` : ''}
    </div>
    ${!calib.isCalibrated ? '<div class="slit-calib-warn">⚠️ 📏 보정 후 cm 단위로 표시됩니다.</div>' : ''}
  `;
}
