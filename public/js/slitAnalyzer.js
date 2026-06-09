// slitAnalyzer.js — 이중슬릿 간섭무늬 분석 (슬릿 A / B / C)

import { Calibration }    from './calibration.js';
import { ZoomController } from './zoomController.js';

const $ = id => document.getElementById(id);

const BRIGHT_H    = 80;   // 밝기 그래프 고정 높이
const LABEL_AREA_H = 50;  // 캔버스 상단 레이블 전용 영역 높이
const SLIT_KEYS = ['A','B','C'];

// ── 슬릿별 상태 ───────────────────────────────────────────
function _mkState(key) {
  return {
    key,
    imgEl:       null,
    fringes:     [],
    centerIdx:   -1,
    selectedIdx: -1,
    scanY:       0,
    calib:       new Calibration(),
    sensitivity: 25,
    mode:        'pan',
  };
}

const slitStates = { A: _mkState('A'), B: _mkState('B'), C: _mkState('C') };
let activeKey = 'A';
let st = slitStates.A;   // 활성 슬릿 상태 참조

let canvas, ctx, brightCanvas, zoom, _show;

// ── 초기화 ────────────────────────────────────────────────
export function initSlitAnalyzer(showScreen) {
  _show        = showScreen;
  canvas       = $('slit-canvas');
  ctx          = canvas.getContext('2d');
  brightCanvas = $('slit-bright-canvas');

  canvas.addEventListener('mousedown',  _down);
  canvas.addEventListener('mousemove',  _move);
  canvas.addEventListener('mouseup',    _up);
  canvas.addEventListener('mouseleave', _leave);

  zoom = new ZoomController(canvas, { onDown: _down, onMove: _move, onUp: _up });

  brightCanvas.addEventListener('mousedown', _downBright);
  brightCanvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.touches[0];
    _downBright({ clientX: t.clientX, clientY: t.clientY });
  }, { passive: false });

  _bindUpload();
  _bindAnalyzeUI();
  _bindReport();
}

// ── 업로드 화면 ──────────────────────────────────────────
function _bindUpload() {
  $('btn-slit-back').addEventListener('click', () => _show('mode'));

  SLIT_KEYS.forEach(k => {
    const fileInput = $(`slit-file-${k}`);
    $(`slit-ucard-${k}`).querySelector('.slit-pick-btn')
      .addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      const f = e.target.files[0];
      if (f) _loadImage(k, f);
      e.target.value = '';
    });
  });

  $('btn-slit-start').addEventListener('click', () => {
    // 이미지 있는 첫 번째 슬릿을 기본 활성화
    const firstKey = SLIT_KEYS.find(k => slitStates[k].imgEl);
    if (!firstKey) return;
    _show('slit-analyze');
    _initTabs();
    _switchSlit(firstKey);
  });
}

function _loadImage(key, file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    slitStates[key].imgEl = img;
    const prev = $(`slit-preview-${key}`);
    prev.src = url;
    prev.classList.remove('hidden');
    $(`slit-filename-${key}`).textContent = `✓ ${file.name}`;
    $(`slit-ucard-${key}`).classList.add('slit-ucard-loaded');
    // 하나라도 있으면 시작 버튼 활성화
    $('btn-slit-start').disabled = !SLIT_KEYS.some(k => slitStates[k].imgEl);
  };
  img.src = url;
}

// ── 분석 화면 UI 바인딩 ──────────────────────────────────
function _bindAnalyzeUI() {
  // 탭 전환
  SLIT_KEYS.forEach(k => {
    $(`slit-tab-${k}`).addEventListener('click', () => {
      if (slitStates[k].imgEl) _switchSlit(k);
    });
  });

  $('btn-slit-back2').addEventListener('click', () => _show('mode'));
  $('btn-slit-reupload').addEventListener('click', () => _show('slit-upload'));
  $('btn-slit-report').addEventListener('click', () => {
    _show('slit-report');
    requestAnimationFrame(() => _buildReport());
  });

  $('slit-btn-pan').addEventListener('click',         () => _setMode('pan'));
  $('slit-btn-calibration').addEventListener('click', () => _setMode('calibration'));
  $('slit-btn-add').addEventListener('click',         () => _setMode('add'));
  $('slit-btn-setcenter').addEventListener('click',   () => _setMode('setcenter'));
  $('slit-btn-detect').addEventListener('click',      _autoDetect);

  $('slit-btn-clear').addEventListener('click', () => {
    st.fringes = []; st.centerIdx = -1; st.selectedIdx = -1;
    _render(); _drawBrightnessGraph(); _updateFringeList(); _updateResults();
  });

  $('slit-calib-ok').addEventListener('click', _applyCalib);
  $('slit-calib-value').addEventListener('keydown', e => { if (e.key === 'Enter') _applyCalib(); });

  $('slit-sensitivity').addEventListener('input', e => {
    st.sensitivity = +e.target.value;
    $('slit-sensitivity-val').textContent = e.target.value;
  });
}

// ── 탭 초기화 & 전환 ─────────────────────────────────────
function _initTabs() {
  SLIT_KEYS.forEach(k => {
    const tab = $(`slit-tab-${k}`);
    const has = !!slitStates[k].imgEl;
    tab.disabled = !has;
    tab.style.opacity = has ? '1' : '0.35';
  });
}

function _switchSlit(key) {
  activeKey = key;
  st = slitStates[key];

  SLIT_KEYS.forEach(k => $(`slit-tab-${k}`)?.classList.toggle('active', k === key));

  // 감도 슬라이더 상태 복원
  $('slit-sensitivity').value = st.sensitivity;
  $('slit-sensitivity-val').textContent = st.sensitivity;

  zoom.reset();
  _setMode(st.mode || 'pan');
  $('slit-calib-panel').classList.add('hidden');

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      _fitCanvas();
      _render();
      _drawBrightnessGraph();
      _updateFringeList();
      _updateResults();
    });
  });
}

// ── 캔버스 크기 조정 ──────────────────────────────────────
function _fitCanvas() {
  const wrap = $('slit-canvas-wrap');
  const maxW = Math.max(100, (wrap?.offsetWidth  || 700) - 16);
  const maxH = Math.max(100, (wrap?.offsetHeight || 500) - 16 - LABEL_AREA_H);
  const img  = st.imgEl;
  if (!img) return;
  const ratio  = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
  const imgW   = Math.round(img.naturalWidth  * ratio);
  const imgH   = Math.round(img.naturalHeight * ratio);
  canvas.width  = imgW;
  canvas.height = imgH + LABEL_AREA_H;   // 상단 레이블 영역 추가
  canvas.style.width    = canvas.width  + 'px';
  canvas.style.height   = canvas.height + 'px';
  canvas.style.maxWidth  = '100%';
  canvas.style.maxHeight = '100%';

  brightCanvas.width  = imgW;
  brightCanvas.height = BRIGHT_H;
  brightCanvas.style.width    = imgW + 'px';
  brightCanvas.style.height   = BRIGHT_H + 'px';
  brightCanvas.style.maxWidth = '100%';

  // 슬릿별 이미지 크기 기록 (LABEL_AREA_H 제외)
  st.canvasW = imgW;
  st.canvasH = imgH;

  if (!st.scanY) st.scanY = Math.round(imgH / 2);
}

// ── 모드 ─────────────────────────────────────────────────
function _setMode(mode) {
  st.mode = mode;
  ['pan','calibration','add','setcenter'].forEach(m =>
    $(`slit-btn-${m}`)?.classList.toggle('active', m === mode)
  );
  const hints = {
    pan:         '핀치/휠로 확대 · 드래그로 이동',
    calibration: '자(ruler)의 두 점 클릭 → 실제 길이 입력',
    add:         '이미지 또는 그래프 클릭 → 무늬 추가 / 재클릭 → 삭제',
    setcenter:   '중앙 밝은 무늬(m=0)를 클릭하여 선택하세요',
  };
  $('slit-mode-hint').textContent = hints[mode] || '';
  canvas.style.cursor       = (mode === 'add' || mode === 'calibration' || mode === 'setcenter') ? 'crosshair' : 'grab';
  brightCanvas.style.cursor = (mode === 'add' || mode === 'setcenter') ? 'crosshair' : 'default';

  if (mode !== 'calibration') {
    $('slit-calib-panel').classList.add('hidden');
    st.calibDragIdx = -1;
  } else if (st.calib.points.length === 2) {
    _showCalibPanel();
  }
}

function _showCalibPanel() {
  $('slit-calib-panel').classList.remove('hidden');
  setTimeout(() => $('slit-calib-value').focus(), 50);
}

function _applyCalib() {
  const v = parseFloat($('slit-calib-value').value);
  if (isNaN(v) || v <= 0) return;
  if (!st.calib.setRealLength(v)) return;
  $('slit-calib-panel').classList.add('hidden');
  _setMode('pan');
  _render(); _drawBrightnessGraph(); _updateFringeList(); _updateResults();
}

// ── 밝기 데이터 읽기 ─────────────────────────────────────
function _readBrightness(sData) {
  const img = sData?.imgEl || st.imgEl;
  if (!img) return null;
  const bw   = canvas.width;
  const imgH = canvas.height - LABEL_AREA_H;  // 이미지 부분만
  const oc   = document.createElement('canvas');
  oc.width   = bw;
  oc.height  = imgH;
  oc.getContext('2d').drawImage(img, 0, 0, bw, imgH);
  const scanY = Math.max(2, Math.min(imgH - 3, Math.round((sData?.scanY ?? st.scanY))));
  const rows  = Math.min(5, imgH - scanY + 2);
  const d     = oc.getContext('2d').getImageData(0, scanY - 2, bw, rows).data;
  const bright = new Float32Array(bw);
  for (let x = 0; x < bw; x++) {
    let sum = 0;
    for (let r = 0; r < rows; r++) {
      const i = (r * bw + x) * 4;
      sum += d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
    }
    bright[x] = sum / rows;
  }
  return bright;
}

// ── 자동 감지 ────────────────────────────────────────────
function _autoDetect() {
  if (!st.imgEl) return;
  const raw = _readBrightness();
  if (!raw) return;
  const smoothed = _gaussSmooth(raw, 3.0);
  const peaks    = _findPeaks(smoothed, st.sensitivity);

  if (peaks.length === 0) {
    alert('무늬를 감지하지 못했습니다.\n노란 스캔선을 밝은 무늬 위로 이동하거나\n감도를 낮춰 다시 시도하세요.');
    return;
  }
  st.fringes = peaks.map(x => ({ xPx: x }));
  st.centerIdx = -1; st.selectedIdx = -1;
  _render(); _drawBrightnessGraph(); _updateFringeList(); _updateResults();
}

function _gaussSmooth(arr, sigma) {
  const half = Math.ceil(sigma * 3);
  const size = half * 2 + 1;
  const k = new Float32Array(size);
  let ksum = 0;
  for (let i = 0; i < size; i++) {
    k[i] = Math.exp(-(i-half)*(i-half) / (2*sigma*sigma));
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

function _findPeaks(arr, minProm) {
  const HALF = 40;
  const n = arr.length, peaks = [];
  for (let x = 1; x < n - 1; x++) {
    if (arr[x] <= arr[x-1] || arr[x] < arr[x+1]) continue;
    const lo = Math.max(0, x - HALF), hi = Math.min(n, x + HALF + 1);
    let base = Infinity;
    for (let j = lo; j < hi; j++) if (j !== x && arr[j] < base) base = arr[j];
    if (arr[x] - (base === Infinity ? 0 : base) < minProm) continue;
    peaks.push(x);
  }
  return peaks;
}

// ── 좌표 변환 ─────────────────────────────────────────────
function _pt(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * canvas.width  / rect.width,
    y: (e.clientY - rect.top)  * canvas.height / rect.height,
  };
}

// ── 캔버스 이벤트 ─────────────────────────────────────────
function _down(e) {
  if (!st.imgEl) return;
  const { x, y } = _pt(e);
  const iy = y - LABEL_AREA_H;  // 이미지 좌표계 y

  // 스캔선 드래그 (이미지 좌표로 비교)
  if (iy >= 0 && Math.abs(iy - st.scanY) < 16) { st.isDraggingScan = true; return; }

  if (st.mode === 'pan') {
    st.panStart = { clientX: e.clientX, clientY: e.clientY };
    canvas.style.cursor = 'grabbing'; return;
  }

  if (st.mode === 'calibration') {
    // 보정점은 이미지 좌표(iy)로 저장
    if (st.calib.points.length === 2 && st.calib.isOnButton(x, iy)) { _showCalibPanel(); return; }
    const nearIdx = st.calib.findPointNear(x, iy);
    if (nearIdx !== -1) { st.calibDragIdx = nearIdx; return; }
    if (st.calib.points.length < 2) {
      st.calib.addPoint(x, iy);
      if (st.calib.points.length === 2) _showCalibPanel();
    }
    _render(); return;
  }

  if (st.mode === 'setcenter') {
    const nearIdx = _nearFringe(x);
    if (nearIdx >= 0) {
      _setCenter(nearIdx);
      _setMode('add');
    }
    return;
  }

  if (st.mode === 'add') {
    const nearIdx = _nearFringe(x);
    if (nearIdx >= 0 && Math.abs(st.fringes[nearIdx].xPx - x) < 14) {
      if (nearIdx === st.selectedIdx) {
        // 이미 선택된 무늬 재클릭 → 삭제
        _deleteFringe(nearIdx); return;
      }
      st.selectedIdx = nearIdx;
    } else {
      _addFringe(x);
    }
    _render(); _drawBrightnessGraph(); _updateFringeList();
  }
}

// 밝기 그래프에서 클릭
function _downBright(e) {
  if (!st.imgEl) return;
  const rect = brightCanvas.getBoundingClientRect();
  const x    = Math.round((e.clientX - rect.left) * canvas.width / rect.width);
  if (x < 0 || x >= canvas.width) return;

  if (st.mode === 'setcenter') {
    const nearIdx = _nearFringe(x);
    if (nearIdx >= 0) { _setCenter(nearIdx); _setMode('add'); }
    return;
  }
  if (st.mode !== 'add') return;

  const nearIdx = _nearFringe(x);
  if (nearIdx >= 0 && Math.abs(st.fringes[nearIdx].xPx - x) < 14) {
    if (nearIdx === st.selectedIdx) { _deleteFringe(nearIdx); return; }
    st.selectedIdx = nearIdx;
  } else {
    _addFringe(x);
  }
  _render(); _drawBrightnessGraph(); _updateFringeList();
}

function _move(e) {
  if (st.isDraggingScan) {
    const imgH = canvas.height - LABEL_AREA_H;
    st.scanY = Math.max(2, Math.min(imgH - 2, _pt(e).y - LABEL_AREA_H));
    _render(); _drawBrightnessGraph(); return;
  }
  if (st.calibDragIdx >= 0) {
    const { x, y } = _pt(e);
    st.calib.movePoint(st.calibDragIdx, x, y - LABEL_AREA_H);  // 이미지 좌표
    if (st.calib.isCalibrated) st.calib.setRealLength(st.calib.realLengthCm);
    _render(); _updateFringeList(); _updateResults(); return;
  }
  if (st.mode === 'pan' && st.panStart) {
    zoom.pan(e.clientX - st.panStart.clientX, e.clientY - st.panStart.clientY);
    st.panStart = { clientX: e.clientX, clientY: e.clientY };
  }
}

function _up() {
  st.isDraggingScan = false; st.calibDragIdx = -1;
  if (st.panStart) { st.panStart = null; canvas.style.cursor = 'grab'; }
}
function _leave() { _up(); }

// ── 무늬 관리 ────────────────────────────────────────────
function _addFringe(xPx) {
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
  _render(); _drawBrightnessGraph(); _updateFringeList(); _updateResults();
}

function _setCenter(idx) {
  st.centerIdx = idx;
  _render(); _drawBrightnessGraph(); _updateFringeList(); _updateResults();
}

function _nearFringe(x) {
  let best = -1, bestD = Infinity;
  st.fringes.forEach((f, i) => {
    const d = Math.abs(f.xPx - x);
    if (d < bestD) { bestD = d; best = i; }
  });
  return bestD < 20 ? best : -1;
}

function _getOrder(idx) { return st.centerIdx < 0 ? null : idx - st.centerIdx; }

// ── 렌더링 ───────────────────────────────────────────────
function _render() {
  if (!st.imgEl) return;
  const imgH = canvas.height - LABEL_AREA_H;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 상단 레이블 영역 배경
  ctx.fillStyle = '#0a0e17';
  ctx.fillRect(0, 0, canvas.width, LABEL_AREA_H);
  ctx.strokeStyle = 'rgba(0,229,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, LABEL_AREA_H); ctx.lineTo(canvas.width, LABEL_AREA_H); ctx.stroke();

  // 이미지는 레이블 영역 아래에
  ctx.drawImage(st.imgEl, 0, LABEL_AREA_H, canvas.width, imgH);

  _drawScanLine();

  // 보정점은 이미지 좌표계 기준이므로 translate
  ctx.save(); ctx.translate(0, LABEL_AREA_H); st.calib.draw(ctx); ctx.restore();

  _drawFringes();
  _drawDeltaYAnnotation();
}

function _drawScanLine() {
  const y = Math.round(st.scanY) + LABEL_AREA_H;   // 이미지 오프셋 적용
  ctx.save();
  ctx.setLineDash([7,5]); ctx.strokeStyle = 'rgba(255,210,0,0.9)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke();
  ctx.setLineDash([]);
  const hx = canvas.width - 18;
  ctx.fillStyle = 'rgba(255,210,0,0.9)';
  ctx.beginPath(); ctx.arc(hx, y, 10, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#000'; ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('↕', hx, y);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

function _drawFringes() {
  const usedRects = [];
  const labelBaseY = 16;   // 레이블 첫 줄 y (두 줄 들어올 때 +20 = 36)

  st.fringes.forEach((f, i) => {
    const isCenter = i === st.centerIdx, isSel = i === st.selectedIdx;
    const order  = _getOrder(i);
    const color  = isCenter ? '#ff6b35' : isSel ? '#00e5ff' : 'rgba(120,220,255,0.8)';
    ctx.save();
    ctx.setLineDash([5,3]); ctx.strokeStyle = color;
    ctx.lineWidth = (isCenter||isSel) ? 2.5 : 1.5;
    // 무늬선은 레이블 영역 아래(이미지 구간)에만
    ctx.beginPath(); ctx.moveTo(f.xPx, LABEL_AREA_H); ctx.lineTo(f.xPx, canvas.height); ctx.stroke();
    ctx.setLineDash([]);

    // 레이블: 중앙(m=0)과 바로 옆 2개(m=±1)만 표시
    let label = null;
    if (order === 0)                                  label = '중앙 밝은 무늬';
    else if (order !== null && Math.abs(order) === 1) label = '첫번째 밝은 무늬';

    if (label) {
      const tw = Math.max(50, label.length * 8 + 8);
      let tx = Math.max(1, Math.min(canvas.width - tw - 1, f.xPx - tw / 2));
      let ty = labelBaseY;
      // 겹침 방지: 박스 하단(ty+6)이 LABEL_AREA_H 내에 들어올 때만 아래로 이동
      while (ty + 20 < LABEL_AREA_H && usedRects.some(r => r.y === ty && tx < r.x + r.w + 6 && tx + tw > r.x - 6)) {
        ty += 20;
      }
      usedRects.push({ x: tx, y: ty, w: tw });
      ctx.fillStyle = isCenter ? 'rgba(255,107,53,0.95)' : 'rgba(20,50,90,0.92)';
      _rrect(ctx, tx, ty - 12, tw, 18, 4); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center'; ctx.fillText(label, tx + tw / 2, ty);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  });
}

// ── Δy 보조선 ────────────────────────────────────────────
function _drawDeltaYAnnotation() {
  if (st.centerIdx < 0) return;
  const center = st.fringes[st.centerIdx];
  const left   = st.centerIdx > 0                      ? st.fringes[st.centerIdx - 1] : null;
  const right  = st.centerIdx < st.fringes.length - 1 ? st.fringes[st.centerIdx + 1] : null;
  if (!left && !right) return;

  const toU = px => st.calib.isCalibrated
    ? `${st.calib.toCm(px).toFixed(2)} cm`
    : `${Math.round(px)} px`;

  // 화살표 y 위치: 이미지 상단에서 22px 아래
  const ay = LABEL_AREA_H + 22;
  const tickH = 8;

  ctx.save();
  ctx.font = 'bold 11px sans-serif';
  ctx.textBaseline = 'middle';

  const pairs = [];
  if (left)  pairs.push({ x1: left.xPx,   x2: center.xPx, label: toU(center.xPx - left.xPx) });
  if (right) pairs.push({ x1: center.xPx, x2: right.xPx,  label: toU(right.xPx - center.xPx) });

  pairs.forEach(({ x1, x2, label }) => {
    const mid = (x1 + x2) / 2;
    const tw  = ctx.measureText(label).width + 8;

    // 수평선 (텍스트 박스 좌우 분리)
    ctx.strokeStyle = 'rgba(255,220,50,0.85)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([]);

    // 왼쪽 선 → 텍스트 박스 직전
    ctx.beginPath(); ctx.moveTo(x1 + 5, ay); ctx.lineTo(mid - tw/2 - 2, ay); ctx.stroke();
    // 오른쪽 선 ← 텍스트 박스 직후
    ctx.beginPath(); ctx.moveTo(mid + tw/2 + 2, ay); ctx.lineTo(x2 - 5, ay); ctx.stroke();

    // 화살표 머리
    ctx.fillStyle = 'rgba(255,220,50,0.9)';
    _arrowTip(x1 + 5, ay, -1);
    _arrowTip(x2 - 5, ay,  1);

    // 수직 틱
    ctx.strokeStyle = 'rgba(255,220,50,0.7)';
    ctx.lineWidth = 1;
    [[x1, -tickH/2, tickH/2], [x2, -tickH/2, tickH/2]].forEach(([x, dy1, dy2]) => {
      ctx.beginPath(); ctx.moveTo(x, ay + dy1); ctx.lineTo(x, ay + dy2); ctx.stroke();
    });

    // 텍스트 배경 + 텍스트
    ctx.fillStyle = 'rgba(15,25,50,0.82)';
    _rrect(ctx, mid - tw/2, ay - 9, tw, 18, 3); ctx.fill();
    ctx.fillStyle = '#ffe066';
    ctx.textAlign = 'center';
    ctx.fillText(label, mid, ay);
  });

  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

function _arrowTip(x, y, dir) {   // dir: -1=왼쪽 화살표, +1=오른쪽 화살표
  const S = 5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + dir * S, y - S * 0.5);
  ctx.lineTo(x + dir * S, y + S * 0.5);
  ctx.closePath();
  ctx.fill();
}

// ── 밝기 그래프 ──────────────────────────────────────────
const SPECTRUM_H = 22;   // 스펙트럼 바 높이

function _drawBrightnessGraph(sData) {
  const data = sData || st;
  if (!data.imgEl || !brightCanvas || brightCanvas.width < 10) return;
  const bw = brightCanvas.width, bh = BRIGHT_H;
  const bctx = brightCanvas.getContext('2d');

  // sData가 다른 슬릿이면 canvas 크기를 임시 맞춰서 밝기 읽기
  let origW, origH;
  if (sData && sData !== st) {
    origW = canvas.width; origH = canvas.height;
    const r = Math.min(bw / sData.imgEl.naturalWidth, 1);
    canvas.width  = Math.round(sData.imgEl.naturalWidth  * r);
    canvas.height = Math.round(sData.imgEl.naturalHeight * r) + LABEL_AREA_H;
  }

  const raw = _readBrightness(data);

  if (sData && sData !== st) {
    canvas.width = origW; canvas.height = origH;
  }

  if (!raw) return;
  const smoothed = _gaussSmooth(raw, 2.5);

  _drawBrightCore(bctx, bw, bh, smoothed, data.fringes, data.centerIdx, data.selectedIdx);
  bctx.fillStyle='rgba(80,80,80,0.7)'; bctx.font='9px monospace';
  bctx.fillText(`scan Y: ${Math.round(data.scanY)} px`, 4, bh - SPECTRUM_H - 3);
}

// 밝기 그래프 + 스펙트럼 바 공통 드로잉 (분석/보고서 공용)
// cropX0, cropX1: 보고서용 x축 크롭 범위 (-1이면 크롭 없음)
function _drawBrightCore(bctx, bw, bh, smoothed, fringes, centerIdx, selectedIdx,
                         fringeXScale = 1, cropX0 = 0, cropX1 = -1) {
  const hasCrop = cropX1 >= 0;
  const srcLen  = smoothed.length;
  const cropW   = hasCrop ? Math.max(1, cropX1 - cropX0 + 1) : bw;
  // 원본 x → 그래프 x 변환
  const toGX = srcX => hasCrop
    ? Math.round((srcX - cropX0) / cropW * bw)
    : srcX;
  // 그래프 x → 원본 x 변환 (스펙트럼 바 픽셀 매핑용)
  const toSrcX = gx => hasCrop
    ? Math.min(srcLen - 1, Math.round(cropX0 + gx * cropW / bw))
    : Math.min(srcLen - 1, gx);

  const xStart = hasCrop ? cropX0 : 0;
  const xEnd   = hasCrop ? cropX1 : bw - 1;

  const graphH = bh - SPECTRUM_H;
  const toY    = v => graphH - (v / 255) * (graphH - 6) - 3;

  // ── 그래프 영역 ──────────────────────
  bctx.fillStyle = '#ffffff';
  bctx.fillRect(0, 0, bw, graphH);

  // 격자선
  bctx.lineWidth = 1;
  [64, 128, 192].forEach(v => {
    bctx.strokeStyle = 'rgba(0,0,0,0.07)';
    bctx.beginPath(); bctx.moveTo(0, toY(v)); bctx.lineTo(bw, toY(v)); bctx.stroke();
  });

  // 채움
  bctx.beginPath();
  for (let xi = xStart; xi <= xEnd; xi++) {
    const gx = toGX(xi);
    xi === xStart ? bctx.moveTo(gx, toY(smoothed[xi])) : bctx.lineTo(gx, toY(smoothed[xi]));
  }
  bctx.lineTo(toGX(xEnd), graphH); bctx.lineTo(0, graphH); bctx.closePath();
  bctx.fillStyle = 'rgba(26,115,232,0.10)'; bctx.fill();

  // 곡선
  bctx.beginPath();
  for (let xi = xStart; xi <= xEnd; xi++) {
    const gx = toGX(xi);
    xi === xStart ? bctx.moveTo(gx, toY(smoothed[xi])) : bctx.lineTo(gx, toY(smoothed[xi]));
  }
  bctx.strokeStyle = '#1a73e8'; bctx.lineWidth = 1.5; bctx.stroke();

  // 무늬 수직선 (그래프)
  bctx.setLineDash([4, 3]);
  fringes.forEach((f, i) => {
    const srcX = Math.round(f.xPx * fringeXScale);
    if (hasCrop && (srcX < cropX0 || srcX > cropX1)) return;
    const gx = toGX(srcX);
    const isCenter = i === centerIdx, isSel = i === selectedIdx;
    bctx.strokeStyle = isCenter ? '#d93025' : isSel ? '#555' : 'rgba(26,115,232,0.5)';
    bctx.lineWidth   = (isCenter || isSel) ? 2 : 1;
    bctx.beginPath(); bctx.moveTo(gx, 0); bctx.lineTo(gx, graphH); bctx.stroke();
  });
  bctx.setLineDash([]);

  // 그래프 테두리
  bctx.strokeStyle = 'rgba(0,0,0,0.15)'; bctx.lineWidth = 1;
  bctx.strokeRect(0.5, 0.5, bw - 1, graphH - 1);

  // ── 스펙트럼 바 ──────────────────────
  bctx.fillStyle = '#000';
  bctx.fillRect(0, graphH, bw, SPECTRUM_H);
  for (let gx = 0; gx < bw; gx++) {
    const v = Math.max(0, Math.min(255, Math.round(smoothed[toSrcX(gx)])));
    bctx.fillStyle = `rgb(${v},${v},${v})`;
    bctx.fillRect(gx, graphH + 1, 1, SPECTRUM_H - 2);
  }

  // 스펙트럼 위 무늬 수직선
  bctx.setLineDash([3, 3]);
  fringes.forEach((f, i) => {
    const srcX = Math.round(f.xPx * fringeXScale);
    if (hasCrop && (srcX < cropX0 || srcX > cropX1)) return;
    const gx = toGX(srcX);
    const isCenter = i === centerIdx;
    bctx.strokeStyle = isCenter ? 'rgba(255,90,40,0.9)' : 'rgba(255,255,255,0.4)';
    bctx.lineWidth   = isCenter ? 1.5 : 1;
    bctx.beginPath(); bctx.moveTo(gx, graphH + 1); bctx.lineTo(gx, graphH + SPECTRUM_H); bctx.stroke();
  });
  bctx.setLineDash([]);
}

function _rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x,y,w,h,r); return; }
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}

// ── 사이드바 업데이트 ─────────────────────────────────────
function _updateFringeList() {
  const list  = $('slit-fringe-list');
  const count = $('slit-fringe-count');
  if (count) count.textContent = st.fringes.length ? `(${st.fringes.length})` : '';
  if (!list) return;

  if (st.fringes.length === 0) {
    list.innerHTML = '<div class="slit-empty-msg">자동 감지 또는<br>➕ 모드로 클릭하여 무늬를 추가하세요.</div>';
    return;
  }
  const refX = st.centerIdx >= 0 ? st.fringes[st.centerIdx].xPx : st.fringes[0].xPx;

  list.innerHTML = st.fringes.map((f, i) => {
    const order = _getOrder(i);
    const isCenter = i===st.centerIdx, isSel = i===st.selectedIdx;
    const dx = f.xPx - refX;
    const sign = dx>0?'+':dx<0?'−':'';
    const posStr = st.calib.isCalibrated
      ? `${sign}${st.calib.toCm(Math.abs(dx)).toFixed(2)} cm`
      : `${sign}${Math.round(Math.abs(dx))} px`;
    let lbl;
    if (order === 0)                              lbl = '중앙 밝은 무늬';
    else if (order !== null && Math.abs(order)===1) lbl = `첫번째 밝은 무늬 (${order>0?'오른쪽':'왼쪽'})`;
    else if (order !== null)                      lbl = `m = ${order>0?'+':''}${order}`;
    else                                          lbl = `무늬 ${i+1}`;
    return `<div class="slit-fringe-item${isSel?' selected':''}${isCenter?' center':''}" data-idx="${i}">
      <div class="slit-fringe-label${isCenter?' center-label':''}">${lbl}</div>
      <div class="slit-fringe-pos">${posStr}</div>
      <div class="slit-fringe-btns">
        <button class="slit-center-btn${isCenter?' active':''}" data-action="center" data-idx="${i}" title="중앙 밝은 무늬로 설정">⭕</button>
        <button class="slit-del-btn" data-action="delete" data-idx="${i}" title="삭제">✕</button>
      </div>
    </div>`;
  }).join('');

  list.onclick = e => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      const idx = +btn.dataset.idx;
      if (btn.dataset.action==='center') _setCenter(idx);
      if (btn.dataset.action==='delete') _deleteFringe(idx);
      return;
    }
    const item = e.target.closest('.slit-fringe-item');
    if (item) { st.selectedIdx=+item.dataset.idx; _render(); _drawBrightnessGraph(); _updateFringeList(); }
  };
}

function _updateResults() {
  const el = $('slit-results');
  if (!el) return;

  if (st.centerIdx < 0) {
    el.innerHTML = st.fringes.length < 1
      ? '<div class="slit-empty-msg">무늬를 추가한 뒤<br>⭕ m=0을 지정하세요.</div>'
      : '<div class="slit-calib-warn">⭕ 중앙 밝은 무늬(m=0)를<br>지정해야 Δy를 계산합니다.</div>';
    return;
  }

  const center = st.fringes[st.centerIdx];
  const left   = st.centerIdx > 0                        ? st.fringes[st.centerIdx - 1] : null;
  const right  = st.centerIdx < st.fringes.length - 1   ? st.fringes[st.centerIdx + 1] : null;

  if (!left && !right) {
    el.innerHTML = '<div class="slit-calib-warn">m=0 좌우에 무늬가 없습니다.</div>';
    return;
  }

  const toU  = px => st.calib.isCalibrated ? `${st.calib.toCm(px).toFixed(3)} cm` : `${Math.round(px)} px`;
  const segs = [];
  if (left)  segs.push({ lbl: '중앙 ← 왼쪽 m=1', px: center.xPx - left.xPx });
  if (right) segs.push({ lbl: '중앙 → 오른쪽 m=1', px: right.xPx - center.xPx });

  const avg  = segs.reduce((a, s) => a + s.px, 0) / segs.length;
  const diff = segs.length > 1 ? Math.abs(segs[0].px - segs[1].px) / 2 : 0;

  const rows = segs.map(s =>
    `<tr><td>${s.lbl}</td><td>${toU(s.px)}</td></tr>`
  ).join('');

  el.innerHTML = `
    <table class="slit-table">
      <thead><tr><th>구간</th><th>Δy</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="slit-avg-box">
      <span>평균 Δy</span><strong>${toU(avg)}</strong>
      ${diff > 0 ? `<span class="slit-std">± ${toU(diff)}</span>` : ''}
    </div>
    ${!st.calib.isCalibrated ? '<div class="slit-calib-warn">⚠️ 📏 보정 후 cm 단위로 표시됩니다.</div>' : ''}`;
}

// ── 보고서 ───────────────────────────────────────────────
function _bindReport() {
  $('btn-sr-back').addEventListener('click', () => _show('slit-analyze'));
  $('btn-sr-save').addEventListener('click', _saveReportPng);
  $('sr-date').value = new Date().toISOString().slice(0,10);
}

// Δy(m=0 ↔ m=±1 평균) 계산
function _calcDeltaY(sData) {
  if (sData.fringes.length < 2 || sData.centerIdx < 0) return null;
  const c = sData.fringes[sData.centerIdx];
  const intervals = [];
  if (sData.centerIdx > 0)
    intervals.push(c.xPx - sData.fringes[sData.centerIdx-1].xPx);
  if (sData.centerIdx < sData.fringes.length-1)
    intervals.push(sData.fringes[sData.centerIdx+1].xPx - c.xPx);
  if (intervals.length === 0) return null;
  const avgPx = intervals.reduce((a,b)=>a+b,0)/intervals.length;
  return sData.calib.isCalibrated ? sData.calib.toCm(avgPx) : avgPx;
}

function _buildReport() {
  // sr-body 전체 너비 기준 (padding 14px×2 제외)
  const srBody  = $('sr-body');
  const bodyW   = srBody ? srBody.clientWidth - 28 : 600;
  const REPORT_W = Math.max(400, bodyW);

  SLIT_KEYS.forEach(k => {
    const sData = slitStates[k];
    const block = $(`sr-block-${k}`);
    if (!sData.imgEl) { block?.classList.add('hidden'); return; }
    block?.classList.remove('hidden');

    const imgCanvas = $(`sr-img-${k}`);
    const ratio     = REPORT_W / sData.imgEl.naturalWidth;
    imgCanvas.width  = REPORT_W;
    imgCanvas.height = Math.round(sData.imgEl.naturalHeight * ratio);
    imgCanvas.style.width  = '100%';
    imgCanvas.style.height = imgCanvas.height + 'px';
    imgCanvas.getContext('2d').drawImage(
      sData.imgEl, 0, 0, imgCanvas.width, imgCanvas.height
    );
    // 무늬 선 표시
    const ictx = imgCanvas.getContext('2d');
    sData.fringes.forEach((f, i) => {
      const px = Math.round(f.xPx * ratio);
      const isCenter = i === sData.centerIdx;
      ictx.strokeStyle = isCenter ? '#ff6b35' : 'rgba(0,229,255,0.8)';
      ictx.lineWidth = isCenter ? 2 : 1;
      ictx.setLineDash([4,3]);
      ictx.beginPath(); ictx.moveTo(px,0); ictx.lineTo(px,imgCanvas.height); ictx.stroke();
      ictx.setLineDash([]);
    });

    // 밝기 그래프 (같은 너비, 130px 높이, 무늬 범위 확대)
    const REPORT_BRIGHT_H = 130;
    const brightC = $(`sr-bright-${k}`);
    brightC.width  = REPORT_W;
    brightC.height = REPORT_BRIGHT_H;
    brightC.style.width  = '100%';
    brightC.style.height = REPORT_BRIGHT_H + 'px';
    _drawBrightnessGraphTo(brightC, REPORT_W, sData, true);

    // Δy 표시
    const dy = _calcDeltaY(sData);
    const dyEl = $(`sr-dy-${k}`);
    if (dyEl) {
      if (dy === null) {
        dyEl.textContent = '-- (m=0 설정 필요)';
      } else {
        dyEl.textContent = sData.calib.isCalibrated
          ? `${dy.toFixed(3)} cm`
          : `${Math.round(dy)} px (보정 필요)`;
      }
    }
  });
}

// 특정 canvas에 밝기 그래프 그리기 (보고서용)
// cropToFringes=true 이면 무늬 범위 중심으로 x축 확대
function _drawBrightnessGraphTo(targetCanvas, targetW, sData, cropToFringes = false) {
  if (!sData.imgEl) return;
  const bh = targetCanvas.height;
  const bw = targetW;

  // 오프스크린에서 sData 이미지 읽기
  const oc = document.createElement('canvas');
  oc.width  = bw;
  oc.height = Math.round(sData.imgEl.naturalHeight * bw / sData.imgEl.naturalWidth);
  oc.getContext('2d').drawImage(sData.imgEl, 0, 0, bw, oc.height);
  const scanY = Math.max(2, Math.min(oc.height - 3,
    Math.round(sData.scanY * oc.height / (sData.imgEl.naturalHeight || oc.height))));
  const rows = Math.min(5, oc.height - scanY + 2);
  const d    = oc.getContext('2d').getImageData(0, scanY - 2, bw, rows).data;
  const bright = new Float32Array(bw);
  for (let x = 0; x < bw; x++) {
    let sum = 0;
    for (let r = 0; r < rows; r++) { const idx=(r*bw+x)*4; sum+=d[idx]*0.299+d[idx+1]*0.587+d[idx+2]*0.114; }
    bright[x] = sum / rows;
  }
  const smoothed = _gaussSmooth(bright, 2.5);

  // 무늬 위치 (bw 스케일 변환)
  const scaledW = sData.canvasW || canvas.width || sData.imgEl.naturalWidth || bw;
  const xScale  = bw / scaledW;

  // cropToFringes: 무늬 범위 ± 여백으로 x축 크롭
  let cropX0 = 0, cropX1 = -1;
  if (cropToFringes && sData.fringes.length > 0) {
    const fringeXs = sData.fringes.map(f => Math.round(f.xPx * xScale));
    const minX = Math.min(...fringeXs), maxX = Math.max(...fringeXs);
    const span   = Math.max(maxX - minX, 20);
    const margin = Math.max(Math.round(span * 0.3), 25);
    cropX0 = Math.max(0,      minX - margin);
    cropX1 = Math.min(bw - 1, maxX + margin);
  }

  _drawBrightCore(
    targetCanvas.getContext('2d'), bw, bh, smoothed,
    sData.fringes, sData.centerIdx, sData.selectedIdx,
    xScale, cropX0, cropX1
  );
}

async function _saveReportPng() {
  const body = $('sr-body');
  if (!body) return;
  if (typeof html2canvas === 'undefined') {
    alert('PNG 저장을 위해 html2canvas 라이브러리가 필요합니다.\n브라우저 인쇄(Ctrl+P → PDF 저장)를 이용해주세요.');
    return;
  }

  // overflow:auto 컨테이너가 스크롤 영역을 자르지 않도록 임시 해제
  const scrollWrap = body.parentElement;
  const prevOverflow  = scrollWrap.style.overflow;
  const prevMaxHeight = scrollWrap.style.maxHeight;
  const prevHeight    = scrollWrap.style.height;
  scrollWrap.style.overflow  = 'visible';
  scrollWrap.style.maxHeight = 'none';
  scrollWrap.style.height    = 'auto';

  try {
    const cvs = await html2canvas(body, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#fff',
      scrollX: 0,
      scrollY: 0,
      width:  body.scrollWidth,
      height: body.scrollHeight,
      windowWidth:  body.scrollWidth,
      windowHeight: body.scrollHeight,
    });
    const a = document.createElement('a');
    a.href = cvs.toDataURL('image/png');
    a.download = `이중슬릿보고서_${$('sr-name')?.value||'학생'}.png`;
    a.click();
  } catch(e) {
    alert('저장 중 오류가 발생했습니다: ' + e.message);
  } finally {
    // 원래 스타일 복원
    scrollWrap.style.overflow  = prevOverflow;
    scrollWrap.style.maxHeight = prevMaxHeight;
    scrollWrap.style.height    = prevHeight;
  }
}
