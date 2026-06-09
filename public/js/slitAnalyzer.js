// slitAnalyzer.js — 이중슬릿 간섭무늬 분석 (슬릿 A / B / C)

import { Calibration }    from './calibration.js';
import { ZoomController } from './zoomController.js';

const $ = id => document.getElementById(id);

const BRIGHT_H    = 220;  // 밝기 그래프 고정 높이 (그래프 클릭으로 무늬 추가)
const LABEL_AREA_H = 50;  // 캔버스 상단 레이블 전용 영역 높이
const SLIT_KEYS = ['A','B','C'];

// ── 슬릿별 상태 ───────────────────────────────────────────
function _mkState(key) {
  return {
    key,
    imgEl:       null,
    originalImg: null,   // 편집 전 원본 이미지
    editParams:  null,   // { angle, brightness, contrast, cropFrac }
    fringes:     [],
    centerIdx:   -1,
    selectedIdx: -1,
    scanY:       0,
    calib:       new Calibration(),
    sensitivity:       25,
    colorChannel:      'lum',   // 'lum' | 'R' | 'G'
    autoEnhance:       true,    // 자동 대비 향상 ON/OFF
    scanBandH:         20,      // 스캔 띠 반높이 (±px)
    mode:              'pan',
    _enhancedCanvas:   null,
    isDraggingFringe:  false,
    draggingFringeIdx: -1,
  };
}

function _resetAnalysis(s) {
  s.fringes = []; s.centerIdx = -1; s.selectedIdx = -1;
  s.calib = new Calibration(); s.scanY = 0;
  s._enhancedCanvas = null; s.canvasW = 0; s.canvasH = 0;
  s.isDraggingFringe = false; s.draggingFringeIdx = -1;
  s.mode = 'pan';
}

const slitStates = { A: _mkState('A'), B: _mkState('B'), C: _mkState('C') };
let activeKey = 'A';
let st = slitStates.A;   // 활성 슬릿 상태 참조

let canvas, ctx, brightCanvas, zoom, _show;

// 밝기 그래프 가로 줌/패닝 뷰포트 (0..1 범위)
const brightVP = { scale: 1, offset: 0, dragX: null, dragOff: 0 };

// 무늬 추가 모드에서 호버 위치 (canvas 좌표계 x, null이면 표시 안 함)
let hoverX = null;

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

  brightCanvas.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (st.mode === 'add') {
      const x = _brightX(e);
      if (x >= 0 && x < canvas.width) {
        const nearIdx = _nearFringe(x);
        const thresh  = Math.max(3, 6 / brightVP.scale);  // ~6 canvas px
        if (nearIdx >= 0 && Math.abs(st.fringes[nearIdx].xPx - x) < thresh) {
          st.isDraggingFringe  = true;
          st.draggingFringeIdx = nearIdx;
          st.selectedIdx       = nearIdx;
          brightCanvas.style.cursor = 'ew-resize';
          _render(); _drawBrightnessGraph(); _updateFringeList();
          return;
        }
      }
    }
    if (brightVP.scale > 1) {
      brightVP.dragX   = e.clientX;
      brightVP.dragOff = brightVP.offset;
    } else {
      _downBright(e);
    }
  });
  brightCanvas.addEventListener('mousemove', e => {
    if (st.isDraggingFringe) {
      const x = _brightX(e);
      st.fringes[st.draggingFringeIdx].xPx = Math.max(0, Math.min(canvas.width - 1, x));
      _render(); _drawBrightnessGraph();
      return;
    }
    if (brightVP.dragX !== null) {
      const rect = brightCanvas.getBoundingClientRect();
      const dx = (e.clientX - brightVP.dragX) / rect.width / brightVP.scale;
      brightVP.offset = Math.max(0, Math.min(1 - 1/brightVP.scale, brightVP.dragOff - dx));
      _drawBrightnessGraph();
      return;
    }
    // 무늬 추가 모드: 그래프 호버 → 캔버스 미리보기
    if (st.mode === 'add') {
      const x = _brightX(e);
      if (x >= 0 && x < canvas.width && x !== hoverX) {
        hoverX = x; _render(); _drawBrightnessGraph();
      }
    }
  });
  brightCanvas.addEventListener('mouseleave', () => {
    if (st.isDraggingFringe || brightVP.dragX !== null) return;
    hoverX = null; _render(); _drawBrightnessGraph();
  });
  brightCanvas.addEventListener('touchmove', e => {
    if (st.isDraggingFringe || st.mode !== 'add') return;
    const t = e.touches[0];
    const x = _brightX(t);
    if (x >= 0 && x < canvas.width) { hoverX = x; _render(); _drawBrightnessGraph(); }
  }, { passive: true });
  brightCanvas.addEventListener('touchend', () => {
    hoverX = null; _render(); _drawBrightnessGraph();
  }, { passive: true });
  brightCanvas.addEventListener('mouseup', e => {
    if (st.isDraggingFringe) {
      _finalizeFringeDrag();
      brightCanvas.style.cursor = st.mode === 'add' ? 'crosshair' : 'default';
      _render(); _drawBrightnessGraph(); _updateFringeList();
      return;
    }
    if (brightVP.dragX !== null) { brightVP.dragX = null; return; }
    _downBright(e);
  });
  brightCanvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect   = brightCanvas.getBoundingClientRect();
    const frac   = (e.clientX - rect.left) / rect.width;
    const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
    const oldVis = 1 / brightVP.scale;
    brightVP.scale  = Math.max(1, Math.min(50, brightVP.scale * factor));
    const newVis    = 1 / brightVP.scale;
    brightVP.offset = Math.max(0, Math.min(1 - newVis, brightVP.offset + frac * (oldVis - newVis)));
    brightCanvas.style.cursor = brightVP.scale > 1 ? 'grab' : 'default';
    _drawBrightnessGraph();
  }, { passive: false });
  brightCanvas.addEventListener('dblclick', () => {
    brightVP.scale = 1; brightVP.offset = 0;
    brightCanvas.style.cursor = 'default';
    _drawBrightnessGraph();
  });
  brightCanvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.touches[0];
    _downBright({ clientX: t.clientX, clientY: t.clientY });
  }, { passive: false });

  _bindUpload();
  _bindAnalyzeUI();
  _bindReport();
  _bindEditor();
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
    const s = slitStates[key];
    _resetAnalysis(s);          // 분석 데이터 초기화
    s.imgEl      = img;
    s.originalImg = img;        // 원본 보존
    s.editParams  = null;       // 편집 파라미터 초기화
    const prev = $(`slit-preview-${key}`);
    prev.src = url;
    prev.classList.remove('hidden');
    $(`slit-filename-${key}`).textContent = `✓ ${file.name}`;
    $(`slit-ucard-${key}`).classList.add('slit-ucard-loaded');
    $(`slit-edit-upload-${key}`)?.classList.remove('hidden');
    $('btn-slit-start').disabled = !SLIT_KEYS.some(k => slitStates[k].imgEl);
    // 현재 분석 화면에서 동일 슬릿이면 캔버스 갱신
    if (activeKey === key && !$('screen-slit-analyze').classList.contains('hidden')) {
      _switchSlit(key);
    }
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
  $('btn-slit-edit-img').addEventListener('click', () => { if (st.imgEl) _openEditor(activeKey); });
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

  $('slit-bandh').addEventListener('input', e => {
    st.scanBandH = +e.target.value;
    $('slit-bandh-val').textContent = e.target.value;
    _render(); _drawBrightnessGraph();
  });

  document.querySelectorAll('.slit-ch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      st.colorChannel = btn.dataset.ch;
      document.querySelectorAll('.slit-ch-btn').forEach(b => b.classList.toggle('active', b === btn));
      st._enhancedCanvas = null;
      _buildEnhanced(st);
      _render();
      _drawBrightnessGraph();
    });
  });

  $('btn-auto-enhance').addEventListener('click', () => {
    st.autoEnhance = !st.autoEnhance;
    _updateEnhanceBtn();
    st._enhancedCanvas = null;
    _buildEnhanced(st);
    _render();
  });
}

function _updateEnhanceBtn() {
  const btn = $('btn-auto-enhance');
  if (!btn) return;
  btn.textContent = st.autoEnhance ? '✨ 자동 보정 ON' : '✨ 자동 보정 OFF';
  btn.classList.toggle('btn-secondary', st.autoEnhance);
  btn.classList.toggle('btn-ghost',     !st.autoEnhance);
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
  // 띠 높이 슬라이더 복원
  $('slit-bandh').value = st.scanBandH || 20;
  $('slit-bandh-val').textContent = st.scanBandH || 20;
  // 색상 채널 버튼 상태 복원
  document.querySelectorAll('.slit-ch-btn').forEach(b => b.classList.toggle('active', b.dataset.ch === (st.colorChannel || 'lum')));
  // 자동 보정 버튼 상태 복원
  _updateEnhanceBtn();

  zoom.reset();
  _setMode(st.mode || 'pan');
  $('slit-calib-panel').classList.add('hidden');
  brightVP.scale = 1; brightVP.offset = 0;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      _fitCanvas();
      _buildEnhanced(st);
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

  const bGraphW = imgW * 2;  // 2배 폭 — 이미지 픽셀당 2 그래프 픽셀 → 고해상도
  brightCanvas.width  = bGraphW;
  brightCanvas.height = BRIGHT_H;
  brightCanvas.style.width    = '100%';
  brightCanvas.style.height   = BRIGHT_H + 'px';
  brightCanvas.style.maxWidth = 'none';

  // 슬릿별 이미지 크기 기록 (LABEL_AREA_H 제외)
  st.canvasW = imgW;
  st.canvasH = imgH;

  if (!st.scanY) st.scanY = Math.round(imgH / 2);
  st._enhancedCanvas = null;   // 캔버스 크기 바뀌면 캐시 무효화
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
  const ch = sData?.colorChannel ?? st.colorChannel ?? 'lum';
  // brightCanvas 폭 기준으로 샘플링 → 이미지에서 더 많은 픽셀 데이터 추출
  const bw   = (brightCanvas?.width > 0 ? brightCanvas.width : canvas.width);
  const imgH = canvas.height - LABEL_AREA_H;  // 이미지 부분만
  const oc   = document.createElement('canvas');
  oc.width   = bw;
  oc.height  = imgH;
  oc.getContext('2d').drawImage(img, 0, 0, bw, imgH);
  const bandH  = sData?.scanBandH ?? st.scanBandH ?? 20;
  const scanY  = Math.max(0, Math.min(imgH - 1, Math.round((sData?.scanY ?? st.scanY))));
  const sy1    = Math.max(0, scanY - bandH);
  const sy2    = Math.min(imgH - 1, scanY + bandH);
  const rows   = sy2 - sy1 + 1;
  const d      = oc.getContext('2d').getImageData(0, sy1, bw, rows).data;
  const bright = new Float32Array(bw);
  // 열별 최대값(column max) → 무늬가 기울거나 곡선이어도 피크를 정확히 잡음
  for (let x = 0; x < bw; x++) {
    let maxVal = 0;
    for (let r = 0; r < rows; r++) {
      const i = (r * bw + x) * 4;
      let val;
      if      (ch === 'R') val = Math.max(0, d[i]   - Math.max(d[i+1], d[i+2]));
      else if (ch === 'G') val = Math.max(0, d[i+1] - Math.max(d[i],   d[i+2]));
      else                 val = d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114;
      if (val > maxVal) maxVal = val;
    }
    bright[x] = maxVal;
  }
  return bright;
}

// ── 자동 감지 ────────────────────────────────────────────
function _downsample(arr, targetLen) {
  if (arr.length <= targetLen) return arr;
  const out = new Float32Array(targetLen);
  const k = arr.length / targetLen;
  for (let i = 0; i < targetLen; i++) {
    const lo = Math.round(i * k), hi = Math.round((i + 1) * k);
    let s = 0;
    for (let j = lo; j < hi; j++) s += arr[j];
    out[i] = s / (hi - lo || 1);
  }
  return out;
}

function _autoDetect() {
  if (!st.imgEl) return;
  const raw = _readBrightness();
  if (!raw) return;
  // xPx는 canvas.width 기준 좌표 → 피크 검출 전 다운샘플
  const data     = _downsample(raw, canvas.width);
  const smoothed = _gaussSmooth(data, 3.0);
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

  // 스캔 띠 드래그 — 띠 범위 전체를 드래그 영역으로
  if (iy >= 0 && Math.abs(iy - st.scanY) <= Math.max(16, st.scanBandH || 20)) { st.isDraggingScan = true; return; }

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
    const nearIdx   = _nearFringe(x);
    const selThresh = Math.max(5 / (zoom?.scale || 1), 1);  // 5 화면 px
    if (nearIdx >= 0 && Math.abs(st.fringes[nearIdx].xPx - x) < selThresh) {
      st.isDraggingFringe  = true;
      st.draggingFringeIdx = nearIdx;
      st.selectedIdx       = nearIdx;
      canvas.style.cursor  = 'ew-resize';
    } else {
      _addFringe(x);
    }
    _render(); _drawBrightnessGraph(); _updateFringeList();
  }
}

// 밝기 그래프 클릭/드래그 → canvas.width 좌표 변환
function _brightX(e) {
  const rect = brightCanvas.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  return Math.round((brightVP.offset + frac / brightVP.scale) * canvas.width);
}

// 밝기 그래프에서 클릭
function _downBright(e) {
  if (!st.imgEl) return;
  const x = _brightX(e);
  if (x < 0 || x >= canvas.width) return;

  if (st.mode === 'setcenter') {
    const nearIdx = _nearFringe(x);
    if (nearIdx >= 0) { _setCenter(nearIdx); _setMode('add'); }
    return;
  }
  if (st.mode !== 'add') return;

  const nearIdx = _nearFringe(x);
  if (nearIdx >= 0 && Math.abs(st.fringes[nearIdx].xPx - x) < 1) {
    st.selectedIdx = nearIdx;  // 기존 무늬 클릭 → 선택만 (그래프는 1 canvas px)
  } else {
    _addFringe(x);
  }
  _render(); _drawBrightnessGraph(); _updateFringeList();
}

function _move(e) {
  if (st.isDraggingFringe) {
    const x = _pt(e).x;
    st.fringes[st.draggingFringeIdx].xPx = Math.max(0, Math.min(canvas.width - 1, x));
    _render(); _drawBrightnessGraph();
    return;
  }
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
    return;
  }
  // 무늬 추가 모드: 호버 위치 → 그래프에 미리보기 표시
  if (st.mode === 'add' && !st.isDraggingFringe && !st.isDraggingScan) {
    const nx = _pt(e).x;
    if (nx !== hoverX) { hoverX = nx; _render(); _drawBrightnessGraph(); }
  }
}

function _up() {
  if (st.isDraggingFringe) {
    _finalizeFringeDrag();
    canvas.style.cursor = 'crosshair';
    _render(); _drawBrightnessGraph(); _updateFringeList();
    return;
  }
  const wasDraggingScan = st.isDraggingScan;
  st.isDraggingScan = false; st.calibDragIdx = -1;
  if (st.panStart) { st.panStart = null; canvas.style.cursor = 'grab'; }
  if (wasDraggingScan) { _buildEnhanced(st); _render(); }
}
function _leave() { _up(); hoverX = null; _render(); _drawBrightnessGraph(); }

function _finalizeFringeDrag() {
  const movedXPx  = st.fringes[st.draggingFringeIdx].xPx;
  const centerXPx = st.centerIdx >= 0 ? st.fringes[st.centerIdx].xPx : null;
  st.fringes.sort((a, b) => a.xPx - b.xPx);
  if (centerXPx !== null) st.centerIdx = st.fringes.findIndex(f => f.xPx === centerXPx);
  st.selectedIdx       = st.fringes.findIndex(f => f.xPx === movedXPx);
  st.isDraggingFringe  = false;
  st.draggingFringeIdx = -1;
}

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

  // 이미지는 레이블 영역 아래에 (대비 향상된 캔버스 우선)
  ctx.drawImage((st.autoEnhance && st._enhancedCanvas) || st.imgEl, 0, LABEL_AREA_H, canvas.width, imgH);

  _drawScanLine();

  // 보정점은 이미지 좌표계 기준이므로 translate
  ctx.save(); ctx.translate(0, LABEL_AREA_H); st.calib.draw(ctx); ctx.restore();

  _drawFringes();
  _drawDeltaYAnnotation();
  if (hoverX !== null && st.mode === 'add') _drawHoverOnCanvas(hoverX);
}

function _drawScanLine() {
  const cy  = Math.round(st.scanY) + LABEL_AREA_H;
  const bh  = st.scanBandH || 20;
  const px  = 1 / (zoom?.scale || 1);
  const ch  = st.colorChannel || 'lum';
  const rgb = ch === 'R' ? '229,57,53' : ch === 'G' ? '67,160,71' : '255,210,0';
  ctx.save();

  // 띠 채움
  ctx.fillStyle = `rgba(${rgb},0.10)`;
  ctx.fillRect(0, cy - bh, canvas.width, bh * 2);

  // 위아래 경계선 (얇은 점선)
  ctx.strokeStyle = `rgba(${rgb},0.45)`; ctx.lineWidth = px;
  ctx.setLineDash([4 * px, 4 * px]);
  ctx.beginPath(); ctx.moveTo(0, cy - bh); ctx.lineTo(canvas.width, cy - bh); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy + bh); ctx.lineTo(canvas.width, cy + bh); ctx.stroke();

  // 중앙 기준선 (두꺼운 점선)
  ctx.strokeStyle = `rgba(${rgb},0.9)`; ctx.lineWidth = px * 2;
  ctx.setLineDash([7 * px, 5 * px]);
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(canvas.width, cy); ctx.stroke();
  ctx.setLineDash([]);

  // 드래그 핸들
  const hx = canvas.width - 18;
  ctx.fillStyle = `rgba(${rgb},0.9)`;
  ctx.beginPath(); ctx.arc(hx, cy, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#000'; ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('↕', hx, cy);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

function _drawHoverOnCanvas(x) {
  const px = 1 / (zoom?.scale || 1);
  ctx.save();
  // 반투명 세로선
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth   = px * 1.5;
  ctx.setLineDash([5 * px, 4 * px]);
  ctx.beginPath(); ctx.moveTo(x, LABEL_AREA_H); ctx.lineTo(x, canvas.height); ctx.stroke();
  ctx.setLineDash([]);
  // 상단 작은 삼각형 (▼) 포인터
  const ty = LABEL_AREA_H + 4;
  const s  = 6 * px;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath(); ctx.moveTo(x, ty + s); ctx.lineTo(x - s * 0.65, ty); ctx.lineTo(x + s * 0.65, ty); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function _drawFringes() {
  const usedRects = [];
  const labelBaseY = 16;
  const px = 1 / (zoom?.scale || 1);   // 화면상 1px — 확대해도 선이 굵어지지 않음

  st.fringes.forEach((f, i) => {
    const isCenter = i === st.centerIdx, isSel = i === st.selectedIdx;
    const order  = _getOrder(i);
    const color  = isCenter ? '#ff6b35' : isSel ? '#00e5ff' : '#00cfff';
    ctx.save();
    ctx.setLineDash([5 * px, 3 * px]);
    // 어두운 아웃라인 먼저 → 밝은 배경에서도 선이 뚜렷하게 보임
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = (isCenter||isSel) ? px * 3.5 : px * 2.5;
    ctx.beginPath(); ctx.moveTo(f.xPx, LABEL_AREA_H); ctx.lineTo(f.xPx, canvas.height); ctx.stroke();
    // 색상 선 오버레이
    ctx.strokeStyle = color;
    ctx.lineWidth = (isCenter||isSel) ? px * 1.5 : px;
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

  const toU = pxVal => st.calib.isCalibrated
    ? `${st.calib.toCm(pxVal).toFixed(2)} cm`
    : `${Math.round(pxVal)} px`;

  const ay    = LABEL_AREA_H + 22;
  const tickH = 8;
  const px    = 1 / (zoom?.scale || 1);  // 화면상 1px

  ctx.save();
  ctx.font = `bold ${Math.round(11 * px)}px sans-serif`;
  ctx.textBaseline = 'middle';

  const pairs = [];
  if (left)  pairs.push({ x1: left.xPx,   x2: center.xPx, label: toU(center.xPx - left.xPx) });
  if (right) pairs.push({ x1: center.xPx, x2: right.xPx,  label: toU(right.xPx - center.xPx) });

  pairs.forEach(({ x1, x2, label }) => {
    const mid = (x1 + x2) / 2;
    const tw  = ctx.measureText(label).width + 8 * px;

    ctx.strokeStyle = 'rgba(255,220,50,0.85)';
    ctx.lineWidth   = px * 1.5;
    ctx.setLineDash([]);

    ctx.beginPath(); ctx.moveTo(x1 + 5*px, ay); ctx.lineTo(mid - tw/2 - 2*px, ay); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mid + tw/2 + 2*px, ay); ctx.lineTo(x2 - 5*px, ay); ctx.stroke();

    ctx.fillStyle = 'rgba(255,220,50,0.9)';
    _arrowTip(x1 + 5*px, ay, -1, px);
    _arrowTip(x2 - 5*px, ay,  1, px);

    ctx.strokeStyle = 'rgba(255,220,50,0.7)';
    ctx.lineWidth = px;
    [[x1, -tickH*px/2, tickH*px/2], [x2, -tickH*px/2, tickH*px/2]].forEach(([x, dy1, dy2]) => {
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

function _arrowTip(x, y, dir, px = 1) {
  const S = 5 * px;
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

  const srcCanvasW = (sData && sData !== st) ? (sData.canvasW || canvas.width) : canvas.width;
  const fXScale    = bw / srcCanvasW;
  // 뷰포트 → cropX0/cropX1 (smoothed.length 기준)
  const dLen  = smoothed.length;
  const cropX0 = brightVP.scale > 1 ? Math.round(brightVP.offset * dLen)                        : 0;
  const cropX1 = brightVP.scale > 1 ? Math.round((brightVP.offset + 1/brightVP.scale) * dLen) - 1 : -1;
  _drawBrightCore(bctx, bw, bh, smoothed, data.fringes, data.centerIdx, data.selectedIdx, fXScale, cropX0, cropX1, data.colorChannel || 'lum');
  bctx.fillStyle='rgba(80,80,80,0.7)'; bctx.font='9px monospace';
  bctx.fillText(`scan Y: ${Math.round(data.scanY)} ±${data.scanBandH||20}px`, 4, bh - SPECTRUM_H - 3);

  // 호버 미리보기선 (무늬 추가 모드, 현재 슬릿만)
  if (hoverX !== null && st.mode === 'add' && (!sData || sData === st)) {
    const graphH  = bh - SPECTRUM_H;
    const hasCrop2 = cropX1 >= 0;
    // hoverX는 canvas 좌표 → brightCanvas 그래프 x로 변환
    const srcLen = smoothed.length;
    const hSrc   = Math.round(hoverX * fXScale);
    const cropW2 = hasCrop2 ? Math.max(1, cropX1 - cropX0 + 1) : bw;
    const hGX    = hasCrop2
      ? Math.round((hSrc - cropX0) / cropW2 * bw)
      : Math.round(hoverX * bw / (canvas.width || bw));
    if (hGX >= 0 && hGX <= bw) {
      // 밝기값 읽기
      const hVal = smoothed[Math.max(0, Math.min(srcLen - 1, hSrc))];
      const toY  = v => {
        let yMin2 = Infinity, yMax2 = -Infinity;
        const xS = hasCrop2 ? cropX0 : 0, xE = hasCrop2 ? cropX1 : bw - 1;
        for (let xi = xS; xi <= xE; xi++) { const v2=smoothed[xi]; if(v2<yMin2)yMin2=v2; if(v2>yMax2)yMax2=v2; }
        const pad = Math.max(4, (yMax2-yMin2)*0.08);
        yMin2 = Math.max(0, yMin2-pad); yMax2 = Math.min(255, yMax2+pad);
        return graphH - ((v - yMin2) / Math.max(1, yMax2-yMin2)) * (graphH - 8) - 4;
      };
      bctx.save();
      // 어두운 점선 (흰 배경에서도 잘 보임)
      bctx.strokeStyle = 'rgba(40,40,40,0.65)';
      bctx.lineWidth   = 1.5;
      bctx.setLineDash([4, 3]);
      bctx.beginPath(); bctx.moveTo(hGX, 0); bctx.lineTo(hGX, graphH); bctx.stroke();
      bctx.setLineDash([]);
      // 밝기값 — 어두운 배경 칩 + 흰 텍스트
      bctx.font = 'bold 10px monospace';
      const label = Math.round(hVal).toString();
      const tw  = bctx.measureText(label).width;
      const lx  = hGX + 5 + tw + 4 < bw ? hGX + 5 : hGX - tw - 9;
      const ly  = Math.min(graphH - 6, Math.max(14, toY(hVal) - 4));
      bctx.fillStyle = 'rgba(30,30,30,0.75)';
      bctx.beginPath();
      if (bctx.roundRect) bctx.roundRect(lx - 2, ly - 11, tw + 6, 14, 3);
      else bctx.rect(lx - 2, ly - 11, tw + 6, 14);
      bctx.fill();
      bctx.fillStyle = '#fff';
      bctx.fillText(label, lx, ly);
      bctx.restore();
    }
  }
}

// 밝기 그래프 + 스펙트럼 바 공통 드로잉 (분석/보고서 공용)
// cropX0, cropX1: 보고서용 x축 크롭 범위 (-1이면 크롭 없음)
function _drawBrightCore(bctx, bw, bh, smoothed, fringes, centerIdx, selectedIdx,
                         fringeXScale = 1, cropX0 = 0, cropX1 = -1, channel = 'lum') {
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

  // Y축 자동 스케일: 표시 범위의 실제 min/max 기준
  let yMin = Infinity, yMax = -Infinity;
  for (let xi = xStart; xi <= xEnd; xi++) {
    const v = smoothed[xi];
    if (v < yMin) yMin = v;
    if (v > yMax) yMax = v;
  }
  const yPad = Math.max(4, (yMax - yMin) * 0.08);
  yMin = Math.max(0,   yMin - yPad);
  yMax = Math.min(255, yMax + yPad);
  const yRange = Math.max(1, yMax - yMin);
  const toY = v => graphH - ((v - yMin) / yRange) * (graphH - 8) - 4;

  // ── 그래프 영역 ──────────────────────
  bctx.fillStyle = '#ffffff';
  bctx.fillRect(0, 0, bw, graphH);

  // 동적 격자선: 데이터 범위에 맞는 간격 선택
  const gridStep = yRange < 20 ? 2 : yRange < 50 ? 5 : yRange < 100 ? 10 : yRange < 200 ? 20 : 50;
  const gridStart = Math.ceil(yMin / gridStep) * gridStep;
  bctx.lineWidth = 1;
  for (let v = gridStart; v <= yMax; v += gridStep) {
    bctx.strokeStyle = 'rgba(0,0,0,0.07)';
    bctx.beginPath(); bctx.moveTo(0, toY(v)); bctx.lineTo(bw, toY(v)); bctx.stroke();
  }

  // Y축 범위 레이블 (우상단)
  bctx.fillStyle = 'rgba(100,100,100,0.75)';
  bctx.font = '10px monospace';
  bctx.textAlign = 'right';
  bctx.fillText(`▲${Math.round(yMax)}`, bw - 3, 12);
  bctx.fillText(`▼${Math.round(yMin)}`, bw - 3, graphH - 4);
  bctx.textAlign = 'left';

  const lineColor = channel === 'R' ? '#e53935' : channel === 'G' ? '#43a047' : '#1a73e8';
  const fillColor = channel === 'R' ? 'rgba(229,57,53,0.10)' : channel === 'G' ? 'rgba(67,160,71,0.10)' : 'rgba(26,115,232,0.10)';

  // 채움
  bctx.beginPath();
  for (let xi = xStart; xi <= xEnd; xi++) {
    const gx = toGX(xi);
    xi === xStart ? bctx.moveTo(gx, toY(smoothed[xi])) : bctx.lineTo(gx, toY(smoothed[xi]));
  }
  bctx.lineTo(toGX(xEnd), graphH); bctx.lineTo(0, graphH); bctx.closePath();
  bctx.fillStyle = fillColor; bctx.fill();

  // 곡선
  bctx.beginPath();
  for (let xi = xStart; xi <= xEnd; xi++) {
    const gx = toGX(xi);
    xi === xStart ? bctx.moveTo(gx, toY(smoothed[xi])) : bctx.lineTo(gx, toY(smoothed[xi]));
  }
  bctx.strokeStyle = lineColor; bctx.lineWidth = 1.5; bctx.stroke();

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
    bctx.fillStyle = channel === 'R' ? `rgb(${v},0,0)` : channel === 'G' ? `rgb(0,${v},0)` : `rgb(${v},${v},${v})`;
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

// ── 이미지 대비 자동 향상 (스캔 띠 기준 퍼센타일 스트레칭) ──────
function _buildEnhanced(sData) {
  const img = sData.imgEl;
  if (!img || !sData.canvasW || !sData.autoEnhance) { sData._enhancedCanvas = null; return; }
  const dw = sData.canvasW, dh = sData.canvasH;
  const ch = sData.colorChannel || 'lum';
  const oc = document.createElement('canvas');
  oc.width = dw; oc.height = dh;
  const oc2 = oc.getContext('2d');
  oc2.drawImage(img, 0, 0, dw, dh);

  if (ch === 'R' || ch === 'G') {
    // 채널 신호 추출: 흰색(R=G=B)→0, 해당 색상 레이저→높은 값
    const full = oc2.getImageData(0, 0, dw, dh);
    const d    = full.data;
    const sigs = new Float32Array(d.length >> 2);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      sigs[j] = ch === 'R'
        ? Math.max(0, d[i]   - Math.max(d[i+1], d[i+2]))
        : Math.max(0, d[i+1] - Math.max(d[i],   d[i+2]));
    }
    // 스캔 띠 기준 2~98 퍼센타일
    const scanY = Math.max(2, Math.min(dh - 3, Math.round(sData.scanY)));
    const sy1   = Math.max(0, scanY - 50), sy2 = Math.min(dh - 1, scanY + 50);
    const stripSigs = [];
    for (let y = sy1; y <= sy2; y++)
      for (let x = 0; x < dw; x++)
        stripSigs.push(sigs[y * dw + x]);
    stripSigs.sort((a, b) => a - b);
    const lo  = stripSigs[Math.floor(stripSigs.length * 0.02)] ?? 0;
    const hi  = stripSigs[Math.floor(stripSigs.length * 0.98)] ?? 1;
    const sc  = 255 / Math.max(1, hi - lo);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const v = Math.max(0, Math.min(255, (sigs[j] - lo) * sc)) | 0;
      d[i]   = ch === 'R' ? v : 0;
      d[i+1] = ch === 'G' ? v : 0;
      d[i+2] = 0;
      d[i+3] = 255;
    }
    oc2.putImageData(full, 0, 0);
    sData._enhancedCanvas = oc;
    return;
  }

  // lum 모드: 스캔 띠(±50px) 밝기 분포로 2~98 퍼센타일 계산
  const scanY = Math.max(2, Math.min(dh - 3, Math.round(sData.scanY)));
  const sy1   = Math.max(0, scanY - 50);
  const sy2   = Math.min(dh - 1, scanY + 50);
  const strip = oc2.getImageData(0, sy1, dw, sy2 - sy1 + 1).data;
  const lums  = new Float32Array(strip.length >> 2);
  for (let i = 0, j = 0; i < strip.length; i += 4, j++)
    lums[j] = strip[i] * 0.299 + strip[i+1] * 0.587 + strip[i+2] * 0.114;
  lums.sort();
  const lo = lums[Math.floor(lums.length * 0.02)] ?? 0;
  const hi = lums[Math.floor(lums.length * 0.98)] ?? 255;

  if (hi - lo >= 200) { sData._enhancedCanvas = oc; return; }  // 이미 충분한 대비

  const full   = oc2.getImageData(0, 0, dw, dh);
  const d      = full.data;
  const scale = 210 / Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const lum = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
    if (lum < 1) continue;
    const newLum = Math.max(0, Math.min(255, (lum - lo) * scale));
    const r = newLum / lum;
    d[i]   = Math.min(255, (d[i]   * r) | 0);
    d[i+1] = Math.min(255, (d[i+1] * r) | 0);
    d[i+2] = Math.min(255, (d[i+2] * r) | 0);
  }
  oc2.putImageData(full, 0, 0);
  sData._enhancedCanvas = oc;
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
      <div class="slit-fringe-footer">
        <div class="slit-fringe-pos">${posStr}</div>
        <div class="slit-fringe-btns">
          <button class="slit-center-btn${isCenter?' active':''}" data-action="center" data-idx="${i}" title="중앙 밝은 무늬로 설정">⭕</button>
          <button class="slit-del-btn" data-action="delete" data-idx="${i}" title="삭제">✕</button>
        </div>
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
    const natW = sData.imgEl.naturalWidth;
    const natH = sData.imgEl.naturalHeight;
    // scanY를 자연 이미지 좌표로 변환해 간섭무늬 띠만 크롭
    const canvasH  = sData.canvasH || natH;
    const natScanY = Math.round(sData.scanY * natH / canvasH);
    const STRIP_NAT  = 120;   // 크롭할 자연 픽셀 높이
    const STRIP_DEST = 80;    // 보고서에 표시할 픽셀 높이
    const srcY = Math.max(0, natScanY - Math.round(STRIP_NAT / 2));
    const srcH = Math.min(STRIP_NAT, natH - srcY);
    imgCanvas.width  = REPORT_W;
    imgCanvas.height = STRIP_DEST;
    imgCanvas.style.width  = '100%';
    imgCanvas.style.height = STRIP_DEST + 'px';
    // 향상된 캔버스(canvasW×canvasH 좌표계) 있으면 우선 사용
    const ictx = imgCanvas.getContext('2d');
    if (sData.autoEnhance && sData._enhancedCanvas && sData.canvasH) {
      const ecScanY  = sData.scanY;
      const ecStripH = Math.round(STRIP_NAT * sData.canvasH / natH);
      const ecSrcY   = Math.max(0, ecScanY - Math.round(ecStripH / 2));
      const ecSrcH   = Math.min(ecStripH, sData.canvasH - ecSrcY);
      ictx.drawImage(sData._enhancedCanvas, 0, ecSrcY, sData.canvasW, ecSrcH, 0, 0, REPORT_W, STRIP_DEST);
    } else {
      ictx.drawImage(sData.imgEl, 0, srcY, natW, srcH, 0, 0, REPORT_W, STRIP_DEST);
    }
    // 무늬 선 표시 — fringes는 canvasW 기준 좌표이므로 canvasW로 스케일
    const fringeScale = REPORT_W / (sData.canvasW || natW);
    sData.fringes.forEach((f, i) => {
      const px = Math.round(f.xPx * fringeScale);
      const isCenter = i === sData.centerIdx;
      ictx.strokeStyle = isCenter ? '#ff6b35' : 'rgba(0,229,255,0.8)';
      ictx.lineWidth = isCenter ? 2 : 1;
      ictx.setLineDash([4,3]);
      ictx.beginPath(); ictx.moveTo(px,0); ictx.lineTo(px,STRIP_DEST); ictx.stroke();
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

  const ch = sData.colorChannel || 'lum';
  // 오프스크린에서 sData 이미지 읽기
  const oc = document.createElement('canvas');
  oc.width  = bw;
  oc.height = Math.round(sData.imgEl.naturalHeight * bw / sData.imgEl.naturalWidth);
  oc.getContext('2d').drawImage(sData.imgEl, 0, 0, bw, oc.height);
  const natH2  = sData.imgEl.naturalHeight || oc.height;
  const scanY  = Math.max(0, Math.min(oc.height - 1,
    Math.round(sData.scanY * oc.height / natH2)));
  const bandH2 = Math.max(1, Math.round((sData.scanBandH || 20) * oc.height / natH2));
  const sy1    = Math.max(0, scanY - bandH2);
  const sy2    = Math.min(oc.height - 1, scanY + bandH2);
  const rows   = sy2 - sy1 + 1;
  const d      = oc.getContext('2d').getImageData(0, sy1, bw, rows).data;
  const bright = new Float32Array(bw);
  for (let x = 0; x < bw; x++) {
    let maxVal = 0;
    for (let r = 0; r < rows; r++) {
      const idx = (r * bw + x) * 4;
      let val;
      if      (ch === 'R') val = Math.max(0, d[idx]   - Math.max(d[idx+1], d[idx+2]));
      else if (ch === 'G') val = Math.max(0, d[idx+1] - Math.max(d[idx],   d[idx+2]));
      else                 val = d[idx]*0.299 + d[idx+1]*0.587 + d[idx+2]*0.114;
      if (val > maxVal) maxVal = val;
    }
    bright[x] = maxVal;
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
    xScale, cropX0, cropX1, ch
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

// ── 이미지 편집기 ─────────────────────────────────────────
let editorKey = null;
let editorCanvas, editorCtx;
const edSt = {  // 에디터 전용 상태
  originalImg: null,
  angle: 0,
  brightness: 0,
  contrast: 0,
  cropFrac: null,      // { x0, y0, x1, y1 } in image-fraction space (0..1)
  cropMode: false,
  cropDragging: false,
  cropStart: null,     // image-fraction { fx, fy }
  // 줌 / 패닝
  zoom: 1,
  panX: 0,
  panY: 0,
  panDragging: false,
  panStart: null,
  // 격자
  showGrid: false,
};

function _bindEditor() {
  editorCanvas = $('editor-canvas');
  if (!editorCanvas) return;
  editorCtx = editorCanvas.getContext('2d');

  // 업로드 화면 편집 버튼
  SLIT_KEYS.forEach(k => {
    $(`slit-edit-upload-${k}`)?.addEventListener('click', () => _openEditor(k));
  });

  // 모달 버튼
  $('btn-editor-cancel').addEventListener('click', _closeEditor);
  $('btn-editor-ok').addEventListener('click', _applyEdits);
  $('btn-editor-reset').addEventListener('click', _resetEditor);
  $('btn-editor-auto-rotate').addEventListener('click', _autoRotate);

  // 크롭 토글
  $('btn-editor-crop-toggle').addEventListener('click', () => {
    edSt.cropMode = !edSt.cropMode;
    $('btn-editor-crop-toggle').textContent = edSt.cropMode ? '✓ 크롭 모드 ON' : '드래그로 영역 선택';
    $('btn-editor-crop-toggle').classList.toggle('btn-secondary', edSt.cropMode);
    $('editor-crop-hint').classList.toggle('hidden', !edSt.cropMode);
    editorCanvas.style.cursor = edSt.cropMode ? 'crosshair' : 'default';
  });
  $('btn-editor-crop-clear').addEventListener('click', () => {
    edSt.cropFrac = null;
    $('btn-editor-crop-clear').classList.add('hidden');
    _renderEditor();
  });

  // 슬라이더
  $('editor-angle').addEventListener('input', e => {
    edSt.angle = parseFloat(e.target.value);
    $('editor-angle-val').textContent = `${edSt.angle.toFixed(1)}°`;
    _renderEditor();
  });
  $('editor-brightness').addEventListener('input', e => {
    edSt.brightness = parseInt(e.target.value);
    $('editor-brightness-val').textContent = edSt.brightness;
    _renderEditor();
  });
  $('editor-contrast').addEventListener('input', e => {
    edSt.contrast = parseInt(e.target.value);
    $('editor-contrast-val').textContent = edSt.contrast;
    _renderEditor();
  });

  // 격자 토글
  $('btn-editor-grid').addEventListener('click', () => {
    edSt.showGrid = !edSt.showGrid;
    $('btn-editor-grid').classList.toggle('btn-secondary', edSt.showGrid);
    $('btn-editor-grid').textContent = edSt.showGrid ? '📐 격자 ON' : '📐 격자 표시';
    _renderEditor();
  });

  // 마우스 이벤트 (크롭 / 패닝)
  editorCanvas.addEventListener('mousedown', _editorDown);
  editorCanvas.addEventListener('mousemove', _editorMoveEvt);
  editorCanvas.addEventListener('mouseup',   _editorUp);
  editorCanvas.addEventListener('mouseleave', _editorUp);

  // 휠 줌
  editorCanvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = editorCanvas.getBoundingClientRect();
    const sx = editorCanvas.width  / rect.width;
    const sy = editorCanvas.height / rect.height;
    const cx = (e.clientX - rect.left) * sx;
    const cy = (e.clientY - rect.top)  * sy;
    const factor = e.deltaY < 0 ? 1.3 : 1 / 1.3;
    _editorZoomAt(cx, cy, edSt.zoom * factor);
  }, { passive: false });

  // 터치 이벤트 (크롭 / 패닝 / 핀치줌)
  let _edPinch0 = null;
  editorCanvas.addEventListener('touchstart', e => {
    e.preventDefault();
    if (e.touches.length === 2) {
      _edPinch0 = { d: Math.hypot(e.touches[1].clientX - e.touches[0].clientX,
                                  e.touches[1].clientY - e.touches[0].clientY),
                    zoom: edSt.zoom };
      return;
    }
    _editorDown({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
  }, { passive: false });
  editorCanvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 2 && _edPinch0) {
      const d = Math.hypot(e.touches[1].clientX - e.touches[0].clientX,
                           e.touches[1].clientY - e.touches[0].clientY);
      const rect = editorCanvas.getBoundingClientRect();
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const sx = (mx - rect.left) * editorCanvas.width  / rect.width;
      const sy = (my - rect.top)  * editorCanvas.height / rect.height;
      _editorZoomAt(sx, sy, _edPinch0.zoom * d / _edPinch0.d);
      return;
    }
    _editorMoveEvt({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
  }, { passive: false });
  editorCanvas.addEventListener('touchend', e => {
    if (e.touches.length < 2) _edPinch0 = null;
    if (e.touches.length === 0) _editorUp();
  });
}

function _openEditor(key) {
  editorKey = key;
  const s = slitStates[key];
  edSt.originalImg = s.originalImg || s.imgEl;
  // 이전 편집 파라미터 복원
  const ep = s.editParams || {};
  edSt.angle      = ep.angle      ?? 0;
  edSt.brightness = ep.brightness ?? 0;
  edSt.contrast   = ep.contrast   ?? 0;
  edSt.cropFrac   = ep.cropFrac   ? { ...ep.cropFrac } : null;
  edSt.cropMode   = false;
  edSt.cropDragging = false;

  $('editor-slit-label').textContent = key;
  $('editor-angle').value      = edSt.angle;
  $('editor-brightness').value = edSt.brightness;
  $('editor-contrast').value   = edSt.contrast;
  $('editor-angle-val').textContent      = `${edSt.angle.toFixed(1)}°`;
  $('editor-brightness-val').textContent = edSt.brightness;
  $('editor-contrast-val').textContent   = edSt.contrast;
  edSt.zoom = 1; edSt.panX = 0; edSt.panY = 0;
  edSt.showGrid = false; edSt.panDragging = false;
  $('btn-editor-crop-toggle').textContent = '드래그로 영역 선택';
  $('btn-editor-crop-toggle').classList.remove('btn-secondary');
  $('btn-editor-crop-clear').classList.toggle('hidden', !edSt.cropFrac);
  $('editor-crop-hint').classList.add('hidden');
  $('btn-editor-grid').textContent = '📐 격자 표시';
  $('btn-editor-grid').classList.remove('btn-secondary');
  editorCanvas.style.cursor = 'grab';
  _updateEditorZoomUI();

  $('slit-editor-modal').classList.remove('hidden');
  requestAnimationFrame(() => { _fitEditorCanvas(); _renderEditor(); });
}

function _closeEditor() {
  $('slit-editor-modal').classList.add('hidden');
  editorKey = null;
}

function _resetEditor() {
  edSt.angle = 0; edSt.brightness = 0; edSt.contrast = 0;
  edSt.cropFrac = null; edSt.cropMode = false;
  edSt.zoom = 1; edSt.panX = 0; edSt.panY = 0;
  edSt.showGrid = false;
  $('editor-angle').value      = 0;
  $('editor-brightness').value = 0;
  $('editor-contrast').value   = 0;
  $('editor-angle-val').textContent      = '0.0°';
  $('editor-brightness-val').textContent = '0';
  $('editor-contrast-val').textContent   = '0';
  $('btn-editor-crop-toggle').textContent = '드래그로 영역 선택';
  $('btn-editor-crop-toggle').classList.remove('btn-secondary');
  $('btn-editor-crop-clear').classList.add('hidden');
  $('editor-crop-hint').classList.add('hidden');
  $('btn-editor-grid').textContent = '📐 격자 표시';
  $('btn-editor-grid').classList.remove('btn-secondary');
  editorCanvas.style.cursor = 'grab';
  _updateEditorZoomUI();
  _renderEditor();
}

function _fitEditorCanvas() {
  const wrap = $('editor-canvas-wrap');
  const img  = edSt.originalImg;
  if (!img || !wrap) return;
  const maxW = Math.max(50, wrap.clientWidth  - 8);
  const maxH = Math.max(50, wrap.clientHeight - 8);
  const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
  editorCanvas.width  = Math.max(1, Math.round(img.naturalWidth  * scale));
  editorCanvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  editorCanvas.style.width  = editorCanvas.width  + 'px';
  editorCanvas.style.height = editorCanvas.height + 'px';
}

// 이미지 분수(0..1) ↔ 캔버스 픽셀 좌표 변환
function _fracToScreen(fx, fy) {
  const W = editorCanvas.width, H = editorCanvas.height;
  return {
    px: (fx - 0.5) * W * edSt.zoom + W / 2 + edSt.panX,
    py: (fy - 0.5) * H * edSt.zoom + H / 2 + edSt.panY,
  };
}
function _screenToFrac(px, py) {
  const W = editorCanvas.width, H = editorCanvas.height;
  return {
    fx: (px - W / 2 - edSt.panX) / (W * edSt.zoom) + 0.5,
    fy: (py - H / 2 - edSt.panY) / (H * edSt.zoom) + 0.5,
  };
}

function _editorZoomAt(cx, cy, newZoom) {
  const W = editorCanvas.width, H = editorCanvas.height;
  newZoom = Math.max(1, Math.min(10, newZoom));
  const r = newZoom / edSt.zoom;
  edSt.panX = (cx - W / 2) * (1 - r) + edSt.panX * r;
  edSt.panY = (cy - H / 2) * (1 - r) + edSt.panY * r;
  edSt.zoom = newZoom;
  if (newZoom <= 1.001) { edSt.zoom = 1; edSt.panX = 0; edSt.panY = 0; }
  _clampEditorPan();
  _updateEditorZoomUI();
  _renderEditor();
}

function _clampEditorPan() {
  const W = editorCanvas.width, H = editorCanvas.height;
  const maxX = W / 2 * (edSt.zoom - 1);
  const maxY = H / 2 * (edSt.zoom - 1);
  edSt.panX = Math.max(-maxX, Math.min(maxX, edSt.panX));
  edSt.panY = Math.max(-maxY, Math.min(maxY, edSt.panY));
}

function _updateEditorZoomUI() {
  const ind = $('editor-zoom-indicator');
  if (!ind) return;
  if (edSt.zoom <= 1) { ind.classList.add('hidden'); return; }
  ind.classList.remove('hidden');
  ind.textContent = `${edSt.zoom.toFixed(1)}×`;
}

function _renderEditor() {
  const img = edSt.originalImg;
  if (!img || !editorCanvas) return;
  const ec = editorCanvas;
  const ectx = editorCtx;
  const W = ec.width, H = ec.height;

  ectx.clearRect(0, 0, W, H);

  // 이미지: 중심 기준 회전 → 줌/패닝
  ectx.save();
  ectx.translate(W / 2 + edSt.panX, H / 2 + edSt.panY);
  ectx.rotate(edSt.angle * Math.PI / 180);
  ectx.scale(edSt.zoom, edSt.zoom);
  ectx.drawImage(img, -W / 2, -H / 2, W, H);
  ectx.restore();

  // 크롭 오버레이 (이미지 분수 → 화면 좌표 변환)
  if (edSt.cropFrac) {
    const p0 = _fracToScreen(edSt.cropFrac.x0, edSt.cropFrac.y0);
    const p1 = _fracToScreen(edSt.cropFrac.x1, edSt.cropFrac.y1);
    const cx = p0.px, cy = p0.py, cw = p1.px - p0.px, ch = p1.py - p0.py;
    ectx.fillStyle = 'rgba(0,0,0,0.45)';
    ectx.fillRect(0, 0, W, cy);
    ectx.fillRect(0, cy + ch, W, H - cy - ch);
    ectx.fillRect(0, cy, cx, ch);
    ectx.fillRect(cx + cw, cy, W - cx - cw, ch);
    ectx.strokeStyle = 'rgba(255,210,0,0.9)';
    ectx.lineWidth = 2;
    ectx.setLineDash([6, 3]);
    ectx.strokeRect(cx, cy, cw, ch);
    ectx.setLineDash([]);
    const HS = 8;
    [[cx,cy],[cx+cw,cy],[cx,cy+ch],[cx+cw,cy+ch]].forEach(([hx,hy]) => {
      ectx.fillStyle = '#ffe066';
      ectx.fillRect(hx - HS/2, hy - HS/2, HS, HS);
    });
  }

  // 격자 (캔버스 고정, 줌 무관)
  if (edSt.showGrid) _drawEditorGrid(ectx, W, H);

  // CSS filter로 밝기/대비 실시간 미리보기
  const bf = 1 + edSt.brightness / 100;
  const cf = edSt.contrast > 0
    ? 1 + edSt.contrast / 50
    : Math.max(0.01, 1 + edSt.contrast / 100);
  ec.style.filter = (bf !== 1 || cf !== 1)
    ? `brightness(${bf.toFixed(3)}) contrast(${cf.toFixed(3)})`
    : '';
}

function _drawEditorGrid(ectx, W, H) {
  ectx.save();
  ectx.setLineDash([]);

  // 3×3 격자 (은은한 흰색)
  ectx.strokeStyle = 'rgba(255,255,255,0.2)';
  ectx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    ectx.beginPath(); ectx.moveTo(W * i / 3, 0); ectx.lineTo(W * i / 3, H); ectx.stroke();
    ectx.beginPath(); ectx.moveTo(0, H * i / 3); ectx.lineTo(W, H * i / 3); ectx.stroke();
  }

  // 5×5 세부 격자 (더 은은하게)
  ectx.strokeStyle = 'rgba(255,255,255,0.08)';
  for (let i = 1; i < 5; i++) {
    if (i % (5/3) === 0) continue;  // 3분할선 중복 방지
    ectx.beginPath(); ectx.moveTo(W * i / 5, 0); ectx.lineTo(W * i / 5, H); ectx.stroke();
    ectx.beginPath(); ectx.moveTo(0, H * i / 5); ectx.lineTo(W, H * i / 5); ectx.stroke();
  }

  // 수평 중심선 (빨간 점선 — 수평 정렬 기준)
  ectx.strokeStyle = 'rgba(255,80,80,0.55)';
  ectx.lineWidth = 1;
  ectx.setLineDash([5, 4]);
  ectx.beginPath(); ectx.moveTo(0, H / 2); ectx.lineTo(W, H / 2); ectx.stroke();

  // 수직 중심선 (파란 점선 — 중앙 기준)
  ectx.strokeStyle = 'rgba(80,160,255,0.55)';
  ectx.beginPath(); ectx.moveTo(W / 2, 0); ectx.lineTo(W / 2, H); ectx.stroke();
  ectx.setLineDash([]);

  ectx.restore();
}

// ── 크롭 / 패닝 인터랙션 ─────────────────────────────────
function _editorPt(e) {
  const rect = editorCanvas.getBoundingClientRect();
  const sx = editorCanvas.width  / rect.width;
  const sy = editorCanvas.height / rect.height;
  return {
    px: Math.max(0, Math.min(editorCanvas.width,  (e.clientX - rect.left) * sx)),
    py: Math.max(0, Math.min(editorCanvas.height, (e.clientY - rect.top)  * sy)),
  };
}

function _editorDown(e) {
  if (edSt.cropMode) {
    const { px, py } = _editorPt(e);
    const { fx, fy } = _screenToFrac(px, py);
    edSt.cropDragging = true;
    edSt.cropStart = { fx, fy };
    edSt.cropFrac = null;
    editorCanvas.style.cursor = 'crosshair';
  } else {
    edSt.panDragging = true;
    edSt.panStart = { clientX: e.clientX, clientY: e.clientY, panX: edSt.panX, panY: edSt.panY };
    editorCanvas.style.cursor = 'grabbing';
  }
}

function _editorMoveEvt(e) {
  if (edSt.cropDragging) {
    const { px, py } = _editorPt(e);
    const { fx, fy } = _screenToFrac(px, py);
    edSt.cropFrac = {
      x0: Math.min(edSt.cropStart.fx, fx),
      y0: Math.min(edSt.cropStart.fy, fy),
      x1: Math.max(edSt.cropStart.fx, fx),
      y1: Math.max(edSt.cropStart.fy, fy),
    };
    _renderEditor();
  } else if (edSt.panDragging && edSt.zoom > 1) {
    const rect = editorCanvas.getBoundingClientRect();
    const scaleX = editorCanvas.width  / rect.width;
    const scaleY = editorCanvas.height / rect.height;
    edSt.panX = edSt.panStart.panX + (e.clientX - edSt.panStart.clientX) * scaleX;
    edSt.panY = edSt.panStart.panY + (e.clientY - edSt.panStart.clientY) * scaleY;
    _clampEditorPan();
    _renderEditor();
  }
}

function _editorUp() {
  if (edSt.cropDragging) {
    edSt.cropDragging = false;
    if (edSt.cropFrac) {
      const w = edSt.cropFrac.x1 - edSt.cropFrac.x0;
      const h = edSt.cropFrac.y1 - edSt.cropFrac.y0;
      if (w < 0.02 || h < 0.02) {
        edSt.cropFrac = null;
      } else {
        $('btn-editor-crop-clear').classList.remove('hidden');
      }
    }
    editorCanvas.style.cursor = 'crosshair';
    _renderEditor();
  }
  if (edSt.panDragging) {
    edSt.panDragging = false;
    editorCanvas.style.cursor = edSt.zoom > 1 ? 'grab' : 'default';
  }
}

// ── 자동 수평 감지 (간섭무늬 기둥 방향 최대 분산) ──────────
async function _autoRotate() {
  const img = edSt.originalImg;
  if (!img) return;

  const btn = $('btn-editor-auto-rotate');
  btn.disabled = true;
  btn.textContent = '⏳ 분석 중...';

  await new Promise(r => setTimeout(r, 20));  // UI 업데이트 대기

  try {
    const W = 160, H = Math.round(160 * img.naturalHeight / img.naturalWidth);
    const oc = new OffscreenCanvas(W, H);
    const octx = oc.getContext('2d');

    let bestAngle = 0, bestScore = -Infinity;

    // 1단계: 1° 단위 탐색
    for (let a = -20; a <= 20; a += 1) {
      const score = _projectionScore(octx, img, W, H, a);
      if (score > bestScore) { bestScore = score; bestAngle = a; }
    }

    // 2단계: 0.2° 단위 정밀 탐색
    bestScore = -Infinity;
    for (let a = bestAngle - 1.5; a <= bestAngle + 1.5; a += 0.2) {
      const score = _projectionScore(octx, img, W, H, a);
      if (score > bestScore) { bestScore = score; bestAngle = a; }
    }

    edSt.angle = parseFloat(bestAngle.toFixed(1));
    $('editor-angle').value = edSt.angle;
    $('editor-angle-val').textContent = `${edSt.angle.toFixed(1)}°`;
    _renderEditor();
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ 자동 수평 감지';
  }
}

function _projectionScore(octx, img, W, H, angleDeg) {
  octx.clearRect(0, 0, W, H);
  octx.save();
  octx.translate(W / 2, H / 2);
  octx.rotate(angleDeg * Math.PI / 180);
  octx.drawImage(img, -W / 2, -H / 2, W, H);
  octx.restore();

  const d = octx.getImageData(0, 0, W, H).data;
  // 중앙 60% 행만 분석 (간섭무늬가 있는 영역에 집중)
  const yS = Math.floor(H * 0.2), yE = Math.floor(H * 0.8);
  const rows = yE - yS;
  const cols = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = yS; y < yE; y++) {
      const i = (y * W + x) * 4;
      sum += d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
    }
    cols[x] = sum / rows;
  }
  const mean = cols.reduce((a, v) => a + v, 0) / W;
  // 분산 + 고주파 성분(인접 열 차이)으로 선명도 함께 측정
  let variance = 0, sharpness = 0;
  for (let x = 0; x < W; x++) {
    variance += (cols[x] - mean) ** 2;
    if (x > 0) sharpness += Math.abs(cols[x] - cols[x-1]);
  }
  return variance + sharpness * 0.3;
}

// ── 편집 적용 ────────────────────────────────────────────
function _applyEdits() {
  const img = edSt.originalImg;
  if (!img) { _closeEditor(); return; }

  const W = img.naturalWidth, H = img.naturalHeight;
  const angle = edSt.angle, b = edSt.brightness, c = edSt.contrast;
  const crop = edSt.cropFrac;

  const oc1 = new OffscreenCanvas(W, H);
  const c1  = oc1.getContext('2d');
  c1.translate(W / 2, H / 2);
  c1.rotate(angle * Math.PI / 180);
  c1.drawImage(img, -W / 2, -H / 2);

  // 크롭 영역 계산
  const srcX = crop ? Math.round(crop.x0 * W) : 0;
  const srcY = crop ? Math.round(crop.y0 * H) : 0;
  const srcW = crop ? Math.max(1, Math.round((crop.x1 - crop.x0) * W)) : W;
  const srcH = crop ? Math.max(1, Math.round((crop.y1 - crop.y0) * H)) : H;

  const oc2 = new OffscreenCanvas(srcW, srcH);
  const c2  = oc2.getContext('2d');
  c2.drawImage(oc1, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

  // 픽셀 단위 밝기/대비 적용
  if (b !== 0 || c !== 0) {
    const id = c2.getImageData(0, 0, srcW, srcH);
    const d  = id.data;
    const bf = b * 2.55;
    const cf = c > 0 ? 1 + c / 50 : Math.max(0.01, 1 + c / 100);
    for (let i = 0; i < d.length; i += 4) {
      for (let ch = 0; ch < 3; ch++) {
        d[i+ch] = Math.max(0, Math.min(255, (d[i+ch] - 128) * cf + 128 + bf));
      }
    }
    c2.putImageData(id, 0, 0);
  }

  oc2.convertToBlob({ type: 'image/jpeg', quality: 0.95 }).then(blob => {
    const url = URL.createObjectURL(blob);
    const newImg = new Image();
    newImg.onload = () => {
      const s = slitStates[editorKey];
      s.imgEl = newImg;
      s.editParams = { angle, brightness: b, contrast: c, cropFrac: crop ? { ...crop } : null };
      _resetAnalysis(s);

      // 업로드 카드 미리보기 갱신
      const prev = $(`slit-preview-${editorKey}`);
      if (prev) { prev.src = url; prev.classList.remove('hidden'); }

      // 분석 화면이 열려 있고 같은 슬릿이면 갱신
      if (!$('screen-slit-analyze').classList.contains('hidden') && activeKey === editorKey) {
        _switchSlit(editorKey);
      }

      _closeEditor();
    };
    newImg.src = url;
  });
}
