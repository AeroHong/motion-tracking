// diffractionAnalyzer.js — 단일슬릿/머리카락 회절 무늬 분석 (측정 3회)
// 수식: d = λ·L / y₁  (y₁ = 중앙 밝은 무늬 중심 ~ 1차 어두운 무늬 거리)

import { Calibration }           from './calibration.js';
import { ZoomController }        from './zoomController.js';
import { pickImageFromDrive }    from './drivePicker.js';
import { auth, db, storage }     from './auth.js';
import { openEditorForExternal } from './slitAnalyzer.js';
import { doc, getDoc, setDoc, Timestamp, collection, addDoc, getDocs, deleteDoc }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

const $ = id => document.getElementById(id);

let BRIGHT_H = 100;
const LABEL_AREA_H = 50;
const RUN_KEYS = ['1', '2', '3'];
const SPECTRUM_H = 22;

// ── 상태 초기화 ───────────────────────────────────────────
function _mkState(key) {
  return {
    key,
    imgEl:       null,
    originalImg: null,
    editParams:  null,
    fringes:     [],
    centerIdx:   -1,
    selectedIdx: -1,
    scanY:       0,
    calib:       new Calibration(),
    L_cm:        '',
    sensitivity:   25,
    colorChannel:  'lum',
    autoEnhance:   true,
    scanBandH:     20,
    mode:          'pan',
    _enhancedCanvas: null,
    isDraggingFringe:  false,
    draggingFringeIdx: -1,
    canvasW: 0,
    canvasH: 0,
  };
}

function _resetAnalysis(s) {
  s.fringes = []; s.centerIdx = -1; s.selectedIdx = -1;
  s.calib = new Calibration(); s.scanY = 0;
  s._enhancedCanvas = null; s.canvasW = 0; s.canvasH = 0;
  s.isDraggingFringe = false; s.draggingFringeIdx = -1;
  s.mode = 'pan';
}

const runStates = { '1': _mkState('1'), '2': _mkState('2'), '3': _mkState('3') };
let activeKey = '1';
let st = runStates['1'];

let canvas, ctx, brightCanvas, zoom, _show;
let _currentExpDocId     = null;
let _currentExpId        = null;
let _currentExpCreatedAt = null;

const brightVP = { scale: 1, offset: 0, dragX: null, dragOff: 0 };
let hoverX = null;
let pendingFringeX = null;

export function refreshDiffExperiments() { _refreshExperimentList(); }

export function initDiffractionAnalyzer(showScreen) {
  _show        = showScreen;
  canvas       = $('diff-canvas');
  ctx          = canvas.getContext('2d');
  brightCanvas = $('diff-bright-canvas');

  canvas.addEventListener('mousedown',  _down);
  canvas.addEventListener('mousemove',  _move);
  canvas.addEventListener('mouseup',    _up);
  canvas.addEventListener('mouseleave', _leave);

  zoom = new ZoomController(canvas, { onDown: _down, onMove: _move, onUp: _up });

  _bindBrightCanvas();
  _bindUpload();
  _bindAnalyzeUI();
  _bindReport();

  auth.onAuthStateChanged(user => {
    if (user) _refreshExperimentList();
  });
}

// ── 밝기 그래프 캔버스 이벤트 ────────────────────────────
function _bindBrightCanvas() {
  brightCanvas.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (st.mode === 'add') {
      const x = _brightX(e);
      if (x >= 0 && x < canvas.width) {
        const nearIdx = _nearFringe(x);
        const thresh  = Math.max(3, 6 / brightVP.scale);
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
}

// ── 업로드 화면 ──────────────────────────────────────────
function _bindUpload() {
  $('btn-diff-back').addEventListener('click', () => _show('mode'));
  $('btn-diff-exp-refresh')?.addEventListener('click', _refreshExperimentList);

  RUN_KEYS.forEach(k => {
    const fileInput = $(`diff-file-${k}`);
    $(`diff-ucard-${k}`).querySelector('.diff-pick-btn')
      .addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      const f = e.target.files[0];
      if (f) _loadImage(k, f);
      e.target.value = '';
    });

    const driveBtn = $(`diff-ucard-${k}`).querySelector('.diff-drive-btn');
    driveBtn.addEventListener('click', async () => {
      driveBtn.disabled = true;
      driveBtn.textContent = '불러오는 중...';
      try {
        const { blob, name } = await pickImageFromDrive();
        const file = new File([blob], name, { type: blob.type });
        _loadImage(k, file);
      } catch (e) {
        if (e.message !== '취소됨') alert('이미지를 불러올 수 없습니다.\n' + e.message);
      } finally {
        driveBtn.disabled = false;
        driveBtn.textContent = '📂 드라이브';
      }
    });
  });

  $('btn-diff-start').addEventListener('click', () => {
    const firstKey = RUN_KEYS.find(k => runStates[k].imgEl);
    if (!firstKey) return;
    _show('diff-analyze');
    _initTabs();
    _switchRun(firstKey);
  });
}

async function _loadImage(key, file) {
  let targetFile = file;

  const isHeic = file.type === 'image/heic' || file.type === 'image/heif' ||
                 /\.(heic|heif)$/i.test(file.name);
  if (isHeic) {
    $(`diff-filename-${key}`).textContent = '⏳ HEIC 변환 중…';
    try {
      const converted = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
      const blob = Array.isArray(converted) ? converted[0] : converted;
      targetFile = new File([blob], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' });
    } catch (e) {
      $(`diff-filename-${key}`).textContent = '❌ HEIC 변환 실패';
      return;
    }
  }

  const url = URL.createObjectURL(targetFile);
  const img = new Image();
  img.onload = () => {
    const s = runStates[key];
    _resetAnalysis(s);
    s.imgEl = img;
    s.originalImg = img;
    s.editParams = null;
    _currentExpDocId = null;
    _currentExpId = null;
    const prev = $(`diff-preview-${key}`);
    prev.src = url;
    prev.classList.remove('hidden');
    $(`diff-filename-${key}`).textContent = `✓ ${targetFile.name}`;
    $(`diff-ucard-${key}`).classList.add('slit-ucard-loaded');
    $('btn-diff-start').disabled = !RUN_KEYS.some(k => runStates[k].imgEl);
    if (activeKey === key && !$('screen-diff-analyze').classList.contains('hidden')) {
      _switchRun(key);
    }
  };
  img.src = url;
}

// ── 분석 화면 UI 바인딩 ──────────────────────────────────
function _bindAnalyzeUI() {
  RUN_KEYS.forEach(k => {
    $(`diff-tab-${k}`).addEventListener('click', () => {
      if (runStates[k].imgEl) _switchRun(k);
    });
  });

  $('btn-diff-back2').addEventListener('click',    () => _show('mode'));
  $('btn-diff-reupload').addEventListener('click', () => { _show('diff-upload'); _refreshExperimentList(); });
  $('btn-diff-save-exp')?.addEventListener('click', _saveExperiment);
  $('btn-diff-report').addEventListener('click', () => {
    _show('diff-report');
    requestAnimationFrame(async () => {
      await _loadReportData();
      const diffLEl = $('diff-lambda'), drLEl = $('dr-lambda');
      if (diffLEl && drLEl && !drLEl.value) drLEl.value = diffLEl.value;
      _buildReport();
    });
  });

  $('btn-diff-edit-img')?.addEventListener('click', () => {
    if (!st.imgEl) return;
    openEditorForExternal(st.originalImg || st.imgEl, st.editParams, (newImg, editParams, url) => {
      st.imgEl = newImg;
      st.editParams = editParams;
      _resetAnalysis(st);
      const prev = $(`diff-preview-${activeKey}`);
      if (prev) { prev.src = url; prev.classList.remove('hidden'); }
      if (!$('screen-diff-analyze').classList.contains('hidden')) _switchRun(activeKey);
    });
  });

  $('diff-btn-pan').addEventListener('click',         () => _setMode('pan'));
  $('diff-btn-calibration').addEventListener('click', () => _setMode('calibration'));
  $('diff-btn-add').addEventListener('click',         () => _setMode('add'));
  $('diff-btn-drag').addEventListener('click',        () => _setMode('drag'));
  $('diff-btn-setcenter').addEventListener('click',   () => _setMode('setcenter'));
  $('diff-btn-detect').addEventListener('click',      _autoDetect);

  $('diff-btn-clear').addEventListener('click', () => {
    st.fringes = []; st.centerIdx = -1; st.selectedIdx = -1;
    _render(); _drawBrightnessGraph(); _updateFringeList(); _updateResults();
  });

  $('diff-calib-ok').addEventListener('click', _applyCalib);
  $('diff-calib-value').addEventListener('keydown', e => { if (e.key === 'Enter') _applyCalib(); });

  // 너지 버튼
  function _nudge(delta) {
    if (st.selectedIdx < 0 || st.selectedIdx >= st.fringes.length) return;
    const f = st.fringes[st.selectedIdx];
    f.xPx = Math.max(0, Math.min((st.canvasW || canvas.width) - 1, f.xPx + delta));
    const centerXPx = st.centerIdx >= 0 ? st.fringes[st.centerIdx].xPx : null;
    st.fringes.sort((a, b) => a.xPx - b.xPx);
    if (centerXPx !== null) st.centerIdx = st.fringes.findIndex(fv => fv.xPx === centerXPx);
    st.selectedIdx = st.fringes.findIndex(fv => fv.xPx === f.xPx);
    _updateResults(); _render(); _drawBrightnessGraph(); _updateFringeList();
  }
  $('diff-nudge-ll')?.addEventListener('click', () => _nudge(-5));
  $('diff-nudge-l')?.addEventListener('click',  () => _nudge(-1));
  $('diff-nudge-r')?.addEventListener('click',  () => _nudge( 1));
  $('diff-nudge-rr')?.addEventListener('click', () => _nudge( 5));
  $('diff-nudge-del')?.addEventListener('click', () => {
    if (st.selectedIdx >= 0) { _deleteFringe(st.selectedIdx); _render(); _drawBrightnessGraph(); _updateFringeList(); _updateResults(); }
  });

  $('diff-sensitivity').addEventListener('input', e => {
    st.sensitivity = +e.target.value;
    $('diff-sensitivity-val').textContent = e.target.value;
  });

  $('diff-bandh').addEventListener('input', e => {
    st.scanBandH = +e.target.value;
    $('diff-bandh-val').textContent = e.target.value;
    _render(); _drawBrightnessGraph();
  });

  document.querySelectorAll('.diff-ch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      st.colorChannel = btn.dataset.ch;
      document.querySelectorAll('.diff-ch-btn').forEach(b => b.classList.toggle('active', b === btn));
      st._enhancedCanvas = null;
      _buildEnhanced(st);
      _render();
      _drawBrightnessGraph();
    });
  });

  $('btn-diff-enhance').addEventListener('click', () => {
    st.autoEnhance = !st.autoEnhance;
    _updateEnhanceBtn();
    st._enhancedCanvas = null;
    _buildEnhanced(st);
    _render();
  });

  // L 값 입력 (측정별)
  $('diff-L-input').addEventListener('input', e => {
    st.L_cm = e.target.value;
    _updateResults();
  });
}

function _updateEnhanceBtn() {
  const btn = $('btn-diff-enhance');
  if (!btn) return;
  btn.textContent = st.autoEnhance ? '✨ 자동 보정 ON' : '✨ 자동 보정 OFF';
  btn.classList.toggle('btn-secondary', st.autoEnhance);
  btn.classList.toggle('btn-ghost', !st.autoEnhance);
}

// ── 탭 초기화 & 전환 ─────────────────────────────────────
function _initTabs() {
  RUN_KEYS.forEach(k => {
    const tab = $(`diff-tab-${k}`);
    const has = !!runStates[k].imgEl;
    tab.disabled = !has;
    tab.style.opacity = has ? '1' : '0.35';
  });
}

function _switchRun(key) {
  activeKey = key;
  st = runStates[key];

  RUN_KEYS.forEach(k => $(`diff-tab-${k}`)?.classList.toggle('active', k === key));

  $('diff-sensitivity').value = st.sensitivity;
  $('diff-sensitivity-val').textContent = st.sensitivity;
  $('diff-bandh').value = st.scanBandH || 20;
  $('diff-bandh-val').textContent = st.scanBandH || 20;
  document.querySelectorAll('.diff-ch-btn').forEach(b => b.classList.toggle('active', b.dataset.ch === (st.colorChannel || 'lum')));
  _updateEnhanceBtn();

  // L 값 복원
  const lInput = $('diff-L-input');
  if (lInput) lInput.value = st.L_cm || '';

  zoom.reset();
  _setMode(st.mode || 'pan');
  $('diff-calib-panel').classList.add('hidden');
  brightVP.scale = 1; brightVP.offset = 0;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      _fitCanvas();
      try { _buildEnhanced(st); } catch(e) { st._enhancedCanvas = null; }
      _render();
      _drawBrightnessGraph();
      _updateFringeList();
      _updateResults();
    });
  });
}

// ── 캔버스 크기 조정 ──────────────────────────────────────
function _fitCanvas() {
  const h = window.innerHeight;
  BRIGHT_H = h < 700 ? 70 : h < 900 ? 85 : 100;

  const wrap = $('diff-canvas-wrap');
  const maxW = Math.max(100, (wrap?.offsetWidth  || 700) - 2);
  const maxH = Math.max(100, (wrap?.offsetHeight || 500) - 2 - LABEL_AREA_H);
  const img  = st.imgEl;
  if (!img) return;
  const ratio = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
  const imgW  = Math.round(img.naturalWidth  * ratio);
  const imgH  = Math.round(img.naturalHeight * ratio);
  canvas.width  = imgW;
  canvas.height = imgH + LABEL_AREA_H;
  canvas.style.width    = canvas.width  + 'px';
  canvas.style.height   = canvas.height + 'px';
  canvas.style.maxWidth  = '100%';
  canvas.style.maxHeight = '100%';

  const bGraphW = imgW * 2;
  brightCanvas.width  = bGraphW;
  brightCanvas.height = BRIGHT_H;
  brightCanvas.style.width    = '100%';
  brightCanvas.style.height   = BRIGHT_H + 'px';
  brightCanvas.style.maxWidth = 'none';

  const prevW = st.canvasW || 0;
  const prevH = st.canvasH || 0;
  st.canvasW = imgW;
  st.canvasH = imgH;

  if (prevW > 0 && prevH > 0 && (prevW !== imgW || prevH !== imgH)) {
    const sx = imgW / prevW;
    const sy = imgH / prevH;
    st.fringes.forEach(f => { f.xPx *= sx; });
    st.scanY *= sy;
    st.calib.points.forEach(p => { p.x *= sx; p.y *= sy; });
    if (st.calib.isCalibrated) st.calib.setRealLength(st.calib.realLengthCm);
  }

  if (!st.scanY) st.scanY = Math.round(imgH / 2);
  st._enhancedCanvas = null;
}

// ── 모드 ─────────────────────────────────────────────────
function _setMode(mode) {
  st.mode = mode;
  ['pan','calibration','add','drag','setcenter'].forEach(m =>
    $(`diff-btn-${m}`)?.classList.toggle('active', m === mode)
  );
  const hints = {
    pan:         '핀치/휠로 확대 · 드래그로 이동',
    calibration: '자(ruler)의 두 점 클릭 → 실제 길이 입력',
    add:         '손 떼면 무늬 추가 확정',
    drag:        '무늬 선 위에서 드래그하여 이동',
    setcenter:   '중앙 밝은 무늬 중심을 클릭하여 선택하세요',
  };
  $('diff-mode-hint').textContent = hints[mode] || '';
  canvas.style.cursor       = (mode === 'add' || mode === 'calibration' || mode === 'setcenter') ? 'crosshair'
                             : mode === 'drag' ? 'ew-resize' : 'grab';
  brightCanvas.style.cursor = (mode === 'add' || mode === 'setcenter') ? 'crosshair' : 'default';

  if (mode !== 'calibration') {
    $('diff-calib-panel').classList.add('hidden');
    st.calibDragIdx = -1;
  } else if (st.calib.points.length === 2) {
    _showCalibPanel();
  }
}

function _showCalibPanel() {
  $('diff-calib-panel').classList.remove('hidden');
  setTimeout(() => $('diff-calib-value').focus(), 50);
}

function _applyCalib() {
  const v = parseFloat($('diff-calib-value').value);
  if (isNaN(v) || v <= 0) return;
  if (!st.calib.setRealLength(v)) return;
  $('diff-calib-panel').classList.add('hidden');
  _setMode('pan');
  _render(); _drawBrightnessGraph(); _updateFringeList(); _updateResults();
}

// ── 밝기 데이터 읽기 (슬릿 분석기와 동일) ───────────────
function _readBrightness(sData) {
  const img = sData?.imgEl || st.imgEl;
  if (!img) return null;
  const ch = sData?.colorChannel ?? st.colorChannel ?? 'lum';
  const bw = (brightCanvas?.width > 0 ? brightCanvas.width : canvas.width);
  const imgH = canvas.height - LABEL_AREA_H;
  const oc = document.createElement('canvas');
  oc.width = bw; oc.height = imgH;
  const oc2d = oc.getContext('2d');
  try { oc2d.drawImage(img, 0, 0, bw, imgH); } catch(e) { return null; }
  const bandH = sData?.scanBandH ?? st.scanBandH ?? 20;
  const scanY = Math.max(0, Math.min(imgH - 1, Math.round((sData?.scanY ?? st.scanY))));
  const sy1   = Math.max(0, scanY - bandH);
  const sy2   = Math.min(imgH - 1, scanY + bandH);
  const rows  = sy2 - sy1 + 1;
  let d; try { d = oc2d.getImageData(0, sy1, bw, rows).data; } catch(e) { return null; }
  const bright = new Float32Array(bw);
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

// ── 자동 감지 (밝기 최대값 + 양쪽 최솟값) ───────────────
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

function _findValleys(arr, minProm) {
  // 밝기의 최솟값(어두운 무늬)을 찾음
  const neg = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) neg[i] = 255 - arr[i];
  return _findPeaks(neg, minProm);
}

function _autoDetect() {
  if (!st.imgEl) return;
  const raw = _readBrightness();
  if (!raw) return;
  const data     = _downsample(raw, canvas.width);
  const smoothed = _gaussSmooth(data, 3.0);

  // 중앙 밝은 무늬(최대값) 찾기
  let maxVal = -Infinity, centerX = Math.round(canvas.width / 2);
  for (let x = 0; x < smoothed.length; x++) {
    if (smoothed[x] > maxVal) { maxVal = smoothed[x]; centerX = x; }
  }

  // 양쪽 어두운 무늬(최솟값) 찾기 — 중심에서 각 방향으로 탐색
  const leftHalf  = smoothed.slice(0, centerX);
  const rightHalf = smoothed.slice(centerX);

  const leftValleys  = _findValleys(_gaussSmooth(leftHalf, 2.5), st.sensitivity * 0.4);
  const rightValleys = _findValleys(_gaussSmooth(rightHalf, 2.5), st.sensitivity * 0.4);

  const leftX  = leftValleys.length  ? leftValleys[leftValleys.length - 1] : null;
  const rightX = rightValleys.length ? rightValleys[0] + centerX           : null;

  if (leftX === null && rightX === null) {
    alert('어두운 무늬를 감지하지 못했습니다.\n스캔선을 회절무늬 위로 이동하거나 감도를 조정하세요.');
    return;
  }

  st.fringes = [{ xPx: centerX }];
  if (leftX  !== null) st.fringes.push({ xPx: leftX });
  if (rightX !== null) st.fringes.push({ xPx: rightX });
  st.fringes.sort((a, b) => a.xPx - b.xPx);
  st.centerIdx  = st.fringes.findIndex(f => f.xPx === centerX);
  st.selectedIdx = -1;

  _render(); _drawBrightnessGraph(); _updateFringeList(); _updateResults();
}

// ── 좌표 변환 & 이벤트 ───────────────────────────────────
function _pt(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * canvas.width  / rect.width,
    y: (e.clientY - rect.top)  * canvas.height / rect.height,
  };
}

function _brightX(e) {
  const rect = brightCanvas.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  return Math.round((brightVP.offset + frac / brightVP.scale) * canvas.width);
}

function _down(e) {
  if (!st.imgEl) return;
  const { x, y } = _pt(e);
  const iy = y - LABEL_AREA_H;

  if (st.mode === 'pan' && iy >= 0 && Math.abs(iy - st.scanY) <= Math.max(16, st.scanBandH || 20)) {
    st.isDraggingScan = true; return;
  }

  if (st.mode === 'pan') {
    st.panStart = { clientX: e.clientX, clientY: e.clientY };
    canvas.style.cursor = 'grabbing'; return;
  }

  if (st.mode === 'calibration') {
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
    if (nearIdx >= 0) { _setCenter(nearIdx); _setMode('add'); }
    return;
  }

  if (st.mode === 'drag') {
    const nearIdx = _nearFringe(x);
    const thresh = Math.max(28 * canvas.width / (canvas.getBoundingClientRect().width || canvas.width) / (zoom?.scale || 1), 3);
    if (nearIdx >= 0 && Math.abs(st.fringes[nearIdx].xPx - x) < thresh) {
      st.isDraggingFringe  = true;
      st.draggingFringeIdx = nearIdx;
      st.selectedIdx       = nearIdx;
      canvas.style.cursor  = 'ew-resize';
      _render(); _drawBrightnessGraph(); _updateFringeList();
    }
    return;
  }

  if (st.mode === 'add') {
    pendingFringeX = x;
    hoverX = null;
    _render(); _drawBrightnessGraph(); _updateFringeList();
  }
}

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
    st.selectedIdx = nearIdx;
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
    st.calib.movePoint(st.calibDragIdx, x, y - LABEL_AREA_H);
    if (st.calib.isCalibrated) st.calib.setRealLength(st.calib.realLengthCm);
    _render(); _updateFringeList(); _updateResults(); return;
  }
  if (st.mode === 'pan' && st.panStart) {
    zoom.pan(e.clientX - st.panStart.clientX, e.clientY - st.panStart.clientY);
    st.panStart = { clientX: e.clientX, clientY: e.clientY };
    return;
  }
  if (st.mode === 'add' && !st.isDraggingFringe && !st.isDraggingScan) {
    const nx = _pt(e).x;
    if (pendingFringeX !== null) {
      pendingFringeX = Math.max(0, Math.min(canvas.width - 1, nx));
      _render(); _drawBrightnessGraph();
    } else if (nx !== hoverX) {
      hoverX = nx; _render(); _drawBrightnessGraph();
    }
  }
}

function _up() {
  if (st.isDraggingFringe) {
    _finalizeFringeDrag();
    canvas.style.cursor = 'crosshair';
    _render(); _drawBrightnessGraph(); _updateFringeList();
    return;
  }
  if (pendingFringeX !== null) {
    _addFringe(pendingFringeX);
    pendingFringeX = null;
    _render(); _drawBrightnessGraph(); _updateFringeList();
    return;
  }
  const wasDraggingScan = st.isDraggingScan;
  st.isDraggingScan = false; st.calibDragIdx = -1;
  if (st.panStart) { st.panStart = null; canvas.style.cursor = 'grab'; }
  if (wasDraggingScan) { _buildEnhanced(st); _render(); }
}

function _leave() {
  if (pendingFringeX !== null) { pendingFringeX = null; }
  _up(); hoverX = null; _render(); _drawBrightnessGraph();
}

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

// ── 렌더링 ───────────────────────────────────────────────
function _render() {
  if (!st.imgEl) return;
  const imgH = canvas.height - LABEL_AREA_H;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0a0e17';
  ctx.fillRect(0, 0, canvas.width, LABEL_AREA_H);
  ctx.strokeStyle = 'rgba(0,229,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, LABEL_AREA_H); ctx.lineTo(canvas.width, LABEL_AREA_H); ctx.stroke();
  ctx.drawImage((st.autoEnhance && st._enhancedCanvas) || st.imgEl, 0, LABEL_AREA_H, canvas.width, imgH);
  _drawScanLine();
  ctx.save(); ctx.translate(0, LABEL_AREA_H); st.calib.draw(ctx); ctx.restore();
  _drawFringes();
  _drawDeltaAnnotation();
  if (pendingFringeX !== null && st.mode === 'add') _drawPendingFringe(pendingFringeX);
  else if (hoverX !== null && st.mode === 'add') _drawHoverOnCanvas(hoverX);
}

function _drawScanLine() {
  const cy  = Math.round(st.scanY) + LABEL_AREA_H;
  const bh  = st.scanBandH || 20;
  const px  = 1 / (zoom?.scale || 1);
  const ch  = st.colorChannel || 'lum';
  const rgb = ch === 'R' ? '229,57,53' : ch === 'G' ? '67,160,71' : '255,210,0';
  ctx.save();
  ctx.fillStyle = `rgba(${rgb},0.10)`;
  ctx.fillRect(0, cy - bh, canvas.width, bh * 2);
  ctx.strokeStyle = `rgba(${rgb},0.45)`; ctx.lineWidth = px;
  ctx.setLineDash([4*px, 4*px]);
  ctx.beginPath(); ctx.moveTo(0, cy - bh); ctx.lineTo(canvas.width, cy - bh); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy + bh); ctx.lineTo(canvas.width, cy + bh); ctx.stroke();
  ctx.strokeStyle = `rgba(${rgb},0.9)`; ctx.lineWidth = px * 2;
  ctx.setLineDash([7*px, 5*px]);
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(canvas.width, cy); ctx.stroke();
  ctx.setLineDash([]);
  const hx = canvas.width - 18;
  ctx.fillStyle = `rgba(${rgb},0.9)`;
  ctx.beginPath(); ctx.arc(hx, cy, 10, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#000'; ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('↕', hx, cy);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

function _drawHoverOnCanvas(x) {
  const px = 1 / (zoom?.scale || 1);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth   = px * 1.5;
  ctx.setLineDash([5*px, 4*px]);
  ctx.beginPath(); ctx.moveTo(x, LABEL_AREA_H); ctx.lineTo(x, canvas.height); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function _drawPendingFringe(x) {
  const px = 1 / (zoom?.scale || 1);
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = px * 4; ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(x, LABEL_AREA_H); ctx.lineTo(x, canvas.height); ctx.stroke();
  ctx.strokeStyle = '#ffe066'; ctx.lineWidth = px * 2;
  ctx.beginPath(); ctx.moveTo(x, LABEL_AREA_H); ctx.lineTo(x, canvas.height); ctx.stroke();
  ctx.restore();
}

function _fringeType(i) {
  if (i === st.centerIdx) return 'center';
  if (st.centerIdx < 0) return 'dark';
  return i < st.centerIdx ? 'dark-left' : 'dark-right';
}

function _drawFringes() {
  const usedRects = [];
  const labelBaseY = 16;
  const px = 1 / (zoom?.scale || 1);

  st.fringes.forEach((f, i) => {
    const type    = _fringeType(i);
    const isSel   = i === st.selectedIdx;
    const isCenter = type === 'center';
    const color    = isCenter ? '#ff6b35' : isSel ? '#00e5ff' : '#aaf';
    ctx.save();
    ctx.setLineDash([5*px, 3*px]);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = (isCenter||isSel) ? px*3.5 : px*2.5;
    ctx.beginPath(); ctx.moveTo(f.xPx, LABEL_AREA_H); ctx.lineTo(f.xPx, canvas.height); ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = (isCenter||isSel) ? px*1.5 : px;
    ctx.beginPath(); ctx.moveTo(f.xPx, LABEL_AREA_H); ctx.lineTo(f.xPx, canvas.height); ctx.stroke();
    ctx.setLineDash([]);

    if (st.mode === 'drag' || (st.isDraggingFringe && st.draggingFringeIdx === i)) {
      const hY = LABEL_AREA_H + 8;
      const hr = Math.max(5, 6*px);
      ctx.fillStyle = isSel ? '#00e5ff' : isCenter ? '#ff6b35' : 'rgba(170,170,255,0.75)';
      ctx.beginPath(); ctx.arc(f.xPx, hY, hr, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = px; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(Math.max(8,8*px))}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('↔', f.xPx, hY);
    }

    let label = null;
    if (isCenter) label = '중앙 밝은 무늬';
    else if (type === 'dark-left')  label = '1차 어두운(좌)';
    else if (type === 'dark-right') label = '1차 어두운(우)';
    else if (type === 'dark') label = `무늬 ${i+1}`;

    if (label) {
      const tw = Math.max(50, label.length * 8 + 8);
      let tx = Math.max(1, Math.min(canvas.width - tw - 1, f.xPx - tw/2));
      let ty = labelBaseY;
      while (ty + 20 < LABEL_AREA_H && usedRects.some(r => r.y === ty && tx < r.x + r.w + 6 && tx + tw > r.x - 6)) ty += 20;
      usedRects.push({ x: tx, y: ty, w: tw });
      ctx.fillStyle = isCenter ? 'rgba(255,107,53,0.95)' : 'rgba(20,30,80,0.92)';
      _rrect(ctx, tx, ty-12, tw, 18, 4); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center'; ctx.fillText(label, tx+tw/2, ty);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  });
}

// y₁ 보조선 (중앙 ~ 어두운 무늬 거리 표시)
function _drawDeltaAnnotation() {
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
  const px    = 1 / (zoom?.scale || 1);

  ctx.save();
  ctx.font = `bold ${Math.round(11*px)}px sans-serif`;
  ctx.textBaseline = 'middle';

  const pairs = [];
  if (left)  pairs.push({ x1: left.xPx,   x2: center.xPx, label: `y₁= ${toU(center.xPx - left.xPx)}` });
  if (right) pairs.push({ x1: center.xPx, x2: right.xPx,  label: `y₁= ${toU(right.xPx - center.xPx)}` });

  pairs.forEach(({ x1, x2, label }) => {
    const mid = (x1 + x2) / 2;
    const tw  = ctx.measureText(label).width + 8*px;
    ctx.strokeStyle = 'rgba(255,220,50,0.85)'; ctx.lineWidth = px*1.5; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x1+5*px, ay); ctx.lineTo(mid-tw/2-2*px, ay); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mid+tw/2+2*px, ay); ctx.lineTo(x2-5*px, ay); ctx.stroke();
    ctx.fillStyle = 'rgba(255,220,50,0.9)';
    _arrowTip(x1+5*px, ay, -1, px);
    _arrowTip(x2-5*px, ay,  1, px);
    ctx.fillStyle = 'rgba(15,25,50,0.82)';
    _rrect(ctx, mid-tw/2, ay-9, tw, 18, 3); ctx.fill();
    ctx.fillStyle = '#ffe066'; ctx.textAlign = 'center';
    ctx.fillText(label, mid, ay);
  });

  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

function _arrowTip(x, y, dir, px = 1) {
  const S = 5*px;
  ctx.beginPath(); ctx.moveTo(x, y);
  ctx.lineTo(x+dir*S, y-S*0.5); ctx.lineTo(x+dir*S, y+S*0.5);
  ctx.closePath(); ctx.fill();
}

// ── 밝기 그래프 ──────────────────────────────────────────
function _drawBrightnessGraph() {
  if (!st.imgEl || !brightCanvas || brightCanvas.width < 10) return;
  const bw = brightCanvas.width, bh = BRIGHT_H;
  const bctx = brightCanvas.getContext('2d');
  const raw = _readBrightness(st);
  if (!raw) return;
  const smoothed = _gaussSmooth(raw, 2.5);
  const fXScale  = bw / canvas.width;
  const dLen = smoothed.length;
  const cropX0 = brightVP.scale > 1 ? Math.round(brightVP.offset * dLen) : 0;
  const cropX1 = brightVP.scale > 1 ? Math.round((brightVP.offset + 1/brightVP.scale) * dLen) - 1 : -1;
  _drawBrightCore(bctx, bw, bh, smoothed, st.fringes, st.centerIdx, st.selectedIdx, fXScale, cropX0, cropX1, st.colorChannel || 'lum');
  bctx.fillStyle='rgba(80,80,80,0.7)'; bctx.font='9px monospace';
  bctx.fillText(`scan Y: ${Math.round(st.scanY)} ±${st.scanBandH||20}px`, 4, bh - SPECTRUM_H - 3);

  if (pendingFringeX !== null && st.mode === 'add') {
    const graphH = bh - SPECTRUM_H;
    const hasCrop = cropX1 >= 0;
    const pSrc = Math.round(pendingFringeX * fXScale);
    const cropW = hasCrop ? Math.max(1, cropX1-cropX0+1) : bw;
    const pGX  = hasCrop ? Math.round((pSrc-cropX0)/cropW*bw) : Math.round(pendingFringeX*bw/(canvas.width||bw));
    if (pGX >= 0 && pGX <= bw) {
      bctx.save();
      bctx.strokeStyle = 'rgba(0,0,0,0.5)'; bctx.lineWidth = 3; bctx.setLineDash([]);
      bctx.beginPath(); bctx.moveTo(pGX, 0); bctx.lineTo(pGX, graphH); bctx.stroke();
      bctx.strokeStyle = '#ffe066'; bctx.lineWidth = 1.5;
      bctx.beginPath(); bctx.moveTo(pGX, 0); bctx.lineTo(pGX, graphH); bctx.stroke();
      bctx.restore();
    }
  }
  if (pendingFringeX === null && hoverX !== null && st.mode === 'add') {
    const graphH = bh - SPECTRUM_H;
    const hasCrop = cropX1 >= 0;
    const cropW = hasCrop ? Math.max(1, cropX1-cropX0+1) : bw;
    const hGX   = hasCrop ? Math.round((Math.round(hoverX*fXScale)-cropX0)/cropW*bw) : Math.round(hoverX*bw/(canvas.width||bw));
    if (hGX >= 0 && hGX <= bw) {
      bctx.save();
      bctx.strokeStyle = 'rgba(40,40,40,0.65)'; bctx.lineWidth = 1.5; bctx.setLineDash([4,3]);
      bctx.beginPath(); bctx.moveTo(hGX, 0); bctx.lineTo(hGX, graphH); bctx.stroke();
      bctx.restore();
    }
  }
}

function _drawBrightCore(bctx, bw, bh, smoothed, fringes, centerIdx, selectedIdx,
                         fringeXScale=1, cropX0=0, cropX1=-1, channel='lum') {
  const hasCrop = cropX1 >= 0;
  const cropW   = hasCrop ? Math.max(1, cropX1-cropX0+1) : bw;
  const toGX    = srcX => hasCrop ? Math.round((srcX-cropX0)/cropW*bw) : srcX;
  const toSrcX  = gx  => hasCrop ? Math.min(smoothed.length-1, Math.round(cropX0+gx*cropW/bw)) : Math.min(smoothed.length-1, gx);

  const xStart = hasCrop ? cropX0 : 0;
  const xEnd   = hasCrop ? cropX1 : bw - 1;
  const graphH = bh - SPECTRUM_H;

  let yMin=Infinity, yMax=-Infinity;
  for (let xi=xStart; xi<=xEnd; xi++) { const v=smoothed[xi]; if(v<yMin)yMin=v; if(v>yMax)yMax=v; }
  const yPad = Math.max(4, (yMax-yMin)*0.08);
  yMin=Math.max(0,yMin-yPad); yMax=Math.min(255,yMax+yPad);
  const yRange = Math.max(1, yMax-yMin);
  const toY = v => graphH - ((v-yMin)/yRange)*(graphH-8) - 4;

  bctx.fillStyle = '#ffffff'; bctx.fillRect(0, 0, bw, graphH);
  const gridStep = yRange<20?2:yRange<50?5:yRange<100?10:yRange<200?20:50;
  const gridStart = Math.ceil(yMin/gridStep)*gridStep;
  bctx.lineWidth=1;
  for (let v=gridStart; v<=yMax; v+=gridStep) {
    bctx.strokeStyle='rgba(0,0,0,0.07)';
    bctx.beginPath(); bctx.moveTo(0,toY(v)); bctx.lineTo(bw,toY(v)); bctx.stroke();
  }
  bctx.fillStyle='rgba(100,100,100,0.75)'; bctx.font='10px monospace'; bctx.textAlign='right';
  bctx.fillText(`▲${Math.round(yMax)}`, bw-3, 12);
  bctx.fillText(`▼${Math.round(yMin)}`, bw-3, graphH-4);
  bctx.textAlign='left';

  const lineColor = channel==='R'?'#e53935':channel==='G'?'#43a047':'#1a73e8';
  const fillColor = channel==='R'?'rgba(229,57,53,0.10)':channel==='G'?'rgba(67,160,71,0.10)':'rgba(26,115,232,0.10)';

  bctx.beginPath();
  for (let xi=xStart; xi<=xEnd; xi++) {
    const gx=toGX(xi);
    xi===xStart?bctx.moveTo(gx,toY(smoothed[xi])):bctx.lineTo(gx,toY(smoothed[xi]));
  }
  bctx.lineTo(toGX(xEnd),graphH); bctx.lineTo(0,graphH); bctx.closePath();
  bctx.fillStyle=fillColor; bctx.fill();

  bctx.beginPath();
  for (let xi=xStart; xi<=xEnd; xi++) {
    const gx=toGX(xi);
    xi===xStart?bctx.moveTo(gx,toY(smoothed[xi])):bctx.lineTo(gx,toY(smoothed[xi]));
  }
  bctx.strokeStyle=lineColor; bctx.lineWidth=1.5; bctx.stroke();

  bctx.setLineDash([4,3]);
  fringes.forEach((f, i) => {
    const srcX = Math.round(f.xPx * fringeXScale);
    if (hasCrop && (srcX<cropX0||srcX>cropX1)) return;
    const gx = toGX(srcX);
    const isCenter = i===centerIdx, isSel = i===selectedIdx;
    bctx.strokeStyle = isCenter?'#d93025':isSel?'#555':'rgba(100,100,200,0.6)';
    bctx.lineWidth   = (isCenter||isSel)?2:1;
    bctx.beginPath(); bctx.moveTo(gx,0); bctx.lineTo(gx,graphH); bctx.stroke();
  });
  bctx.setLineDash([]);

  bctx.strokeStyle='rgba(0,0,0,0.15)'; bctx.lineWidth=1;
  bctx.strokeRect(0.5,0.5,bw-1,graphH-1);

  bctx.fillStyle='#000'; bctx.fillRect(0,graphH,bw,SPECTRUM_H);
  for (let gx=0; gx<bw; gx++) {
    const v=Math.max(0,Math.min(255,Math.round(smoothed[toSrcX(gx)])));
    bctx.fillStyle=channel==='R'?`rgb(${v},0,0)`:channel==='G'?`rgb(0,${v},0)`:`rgb(${v},${v},${v})`;
    bctx.fillRect(gx,graphH+1,1,SPECTRUM_H-2);
  }
  bctx.setLineDash([3,3]);
  fringes.forEach((f, i) => {
    const srcX = Math.round(f.xPx * fringeXScale);
    if (hasCrop && (srcX<cropX0||srcX>cropX1)) return;
    const gx = toGX(srcX);
    bctx.strokeStyle = i===centerIdx?'rgba(255,90,40,0.9)':'rgba(255,255,255,0.4)';
    bctx.lineWidth   = i===centerIdx?1.5:1;
    bctx.beginPath(); bctx.moveTo(gx,graphH+1); bctx.lineTo(gx,graphH+SPECTRUM_H); bctx.stroke();
  });
  bctx.setLineDash([]);
}

// ── 자동 대비 향상 ───────────────────────────────────────
function _buildEnhanced(sData) {
  const img = sData.imgEl;
  if (!img || !sData.canvasW || !sData.autoEnhance) { sData._enhancedCanvas = null; return; }
  const dw = sData.canvasW, dh = sData.canvasH;
  const ch = sData.colorChannel || 'lum';
  const oc = document.createElement('canvas');
  oc.width = dw; oc.height = dh;
  const oc2 = oc.getContext('2d');
  try { oc2.drawImage(img, 0, 0, dw, dh); } catch(e) { sData._enhancedCanvas = null; return; }

  if (ch === 'R' || ch === 'G') {
    let full; try { full = oc2.getImageData(0, 0, dw, dh); } catch(e) { sData._enhancedCanvas = null; return; }
    const d = full.data;
    const sigs = new Float32Array(d.length>>2);
    for (let i=0,j=0; i<d.length; i+=4,j++) {
      const sat = Math.min(d[i],d[i+1],d[i+2]);
      sigs[j] = ch==='R'
        ? Math.max(0,d[i]-Math.max(d[i+1],d[i+2]))+sat
        : Math.max(0,d[i+1]-Math.max(d[i],d[i+2]))+sat;
    }
    const scanY = Math.max(2, Math.min(dh-3, Math.round(sData.scanY)));
    const sy1=Math.max(0,scanY-50), sy2=Math.min(dh-1,scanY+50);
    const stripSigs=[];
    for (let y=sy1;y<=sy2;y++) for (let x=0;x<dw;x++) stripSigs.push(sigs[y*dw+x]);
    stripSigs.sort((a,b)=>a-b);
    const lo=stripSigs[Math.floor(stripSigs.length*0.02)]??0;
    const hi=stripSigs[Math.floor(stripSigs.length*0.98)]??1;
    const sc=255/Math.max(1,hi-lo);
    for (let i=0,j=0; i<d.length; i+=4,j++) {
      const v=Math.max(0,Math.min(255,(sigs[j]-lo)*sc))|0;
      d[i]=ch==='R'?v:0; d[i+1]=ch==='G'?v:0; d[i+2]=0; d[i+3]=255;
    }
    oc2.putImageData(full,0,0);
    sData._enhancedCanvas=oc; return;
  }

  const scanY=Math.max(2,Math.min(dh-3,Math.round(sData.scanY)));
  const sy1=Math.max(0,scanY-50), sy2=Math.min(dh-1,scanY+50);
  let strip; try { strip=oc2.getImageData(0,sy1,dw,sy2-sy1+1).data; } catch(e) { sData._enhancedCanvas=null; return; }
  const lums=new Float32Array(strip.length>>2);
  for (let i=0,j=0; i<strip.length; i+=4,j++)
    lums[j]=strip[i]*0.299+strip[i+1]*0.587+strip[i+2]*0.114;
  lums.sort();
  const lo=lums[Math.floor(lums.length*0.02)]??0;
  const hi=lums[Math.floor(lums.length*0.98)]??255;
  if (hi-lo>=200) { sData._enhancedCanvas=oc; return; }
  let full2; try { full2=oc2.getImageData(0,0,dw,dh); } catch(e) { sData._enhancedCanvas=null; return; }
  const full=full2, d=full.data;
  const scale=210/Math.max(1,hi-lo);
  for (let i=0; i<d.length; i+=4) {
    const lum=d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114;
    if (lum<1) continue;
    const newLum=Math.max(0,Math.min(255,(lum-lo)*scale));
    const r=newLum/lum;
    d[i]=Math.min(255,(d[i]*r)|0); d[i+1]=Math.min(255,(d[i+1]*r)|0); d[i+2]=Math.min(255,(d[i+2]*r)|0);
  }
  oc2.putImageData(full,0,0);
  sData._enhancedCanvas=oc;
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
  const list  = $('diff-fringe-list');
  const count = $('diff-fringe-count');
  if (count) count.textContent = st.fringes.length ? `(${st.fringes.length})` : '';

  const nudgeBar = $('diff-nudge-bar');
  if (nudgeBar) {
    const hasSel = st.selectedIdx >= 0 && st.selectedIdx < st.fringes.length;
    nudgeBar.classList.toggle('hidden', !hasSel);
    if (hasSel) {
      const lbl = $('diff-nudge-fringe-label');
      const type = _fringeType(st.selectedIdx);
      if (lbl) lbl.textContent = type==='center'?'중앙 밝은 무늬':type==='dark-left'?'1차 어두운(좌)':type==='dark-right'?'1차 어두운(우)':'무늬';
    }
  }

  if (!list) return;
  if (st.fringes.length === 0) {
    list.innerHTML = '<div class="slit-empty-msg">자동 감지 또는<br>➕ 모드로 클릭하여 무늬를 추가하세요.</div>';
    return;
  }

  const refX = st.centerIdx >= 0 ? st.fringes[st.centerIdx].xPx : st.fringes[0].xPx;
  list.innerHTML = st.fringes.map((f, i) => {
    const type = _fringeType(i);
    const isSel = i===st.selectedIdx, isCenter = type==='center';
    const dx = f.xPx - refX;
    const sign = dx>0?'+':dx<0?'−':'';
    const posStr = st.calib.isCalibrated
      ? `${sign}${st.calib.toCm(Math.abs(dx)).toFixed(2)} cm`
      : `${sign}${Math.round(Math.abs(dx))} px`;
    const lbl = type==='center'?'중앙 밝은 무늬':type==='dark-left'?'1차 어두운 무늬 (좌)':type==='dark-right'?'1차 어두운 무늬 (우)':`무늬 ${i+1}`;
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

// ── 결과 계산 (d = λ·L / y₁) ──────────────────────────
function _calcY1(sData) {
  if (sData.centerIdx < 0 || sData.fringes.length < 2) return null;
  const c = sData.fringes[sData.centerIdx];
  const left  = sData.centerIdx > 0                       ? sData.fringes[sData.centerIdx-1] : null;
  const right = sData.centerIdx < sData.fringes.length-1  ? sData.fringes[sData.centerIdx+1] : null;
  const leftVal  = left  ? (sData.calib.isCalibrated ? sData.calib.toCm(c.xPx - left.xPx)  : c.xPx - left.xPx)  : null;
  const rightVal = right ? (sData.calib.isCalibrated ? sData.calib.toCm(right.xPx - c.xPx) : right.xPx - c.xPx) : null;
  const vals = [leftVal, rightVal].filter(v => v !== null);
  if (vals.length === 0) return null;
  return { avg: vals.reduce((a,b)=>a+b,0)/vals.length, left: leftVal, right: rightVal };
}

function _calcD(sData, lambdaNm) {
  const y1 = _calcY1(sData);
  if (!y1 || !sData.calib.isCalibrated) return null;
  const L = parseFloat(sData.L_cm);
  if (!L || L <= 0) return null;
  // d(μm) = λ(nm) × L(cm) / y₁(cm) / 1000
  return lambdaNm * L / y1.avg / 1000;
}

function _getLambda() {
  return parseFloat($('diff-lambda')?.value) || 650;
}

function _updateResults() {
  const el = $('diff-results');
  if (!el) return;
  const lambda = _getLambda();

  if (st.centerIdx < 0) {
    el.innerHTML = st.fringes.length < 1
      ? '<div class="slit-empty-msg">무늬를 추가한 뒤<br>⭕ 중앙 밝은 무늬를 지정하세요.</div>'
      : '<div class="slit-calib-warn">⭕ 중앙 밝은 무늬(중심)를<br>지정해야 y₁을 계산합니다.</div>';
    return;
  }

  const y1 = _calcY1(st);
  if (!y1) {
    el.innerHTML = '<div class="slit-calib-warn">중앙 좌우에 무늬가 없습니다.</div>';
    return;
  }

  const toU = v => st.calib.isCalibrated ? `${v.toFixed(3)} cm` : `${Math.round(v)} px`;
  const d = _calcD(st, lambda);
  const L = parseFloat(st.L_cm);

  let html = `<table class="slit-table">
    <thead><tr><th>항목</th><th>값</th></tr></thead>
    <tbody>`;
  if (y1.left  != null) html += `<tr><td>y₁ (좌)</td><td>${toU(y1.left)}</td></tr>`;
  if (y1.right != null) html += `<tr><td>y₁ (우)</td><td>${toU(y1.right)}</td></tr>`;
  html += `<tr><td><strong>y₁ 평균</strong></td><td><strong>${toU(y1.avg)}</strong></td></tr>`;
  html += `</tbody></table>`;

  if (!st.calib.isCalibrated) {
    html += '<div class="slit-calib-warn">⚠️ 📏 보정 후 cm 단위로 표시됩니다.</div>';
  } else if (!L || L <= 0) {
    html += '<div class="slit-calib-warn">⚠️ L (스크린 거리) 을 입력하세요.</div>';
  } else {
    html += `<div class="slit-avg-box">
      <span>머리카락 두께</span>
      <strong>${d !== null ? d.toFixed(2) + ' μm' : '--'}</strong>
    </div>`;
  }

  el.innerHTML = html;
}

// ── 보고서 ───────────────────────────────────────────────
const _REPORT_FIELDS = [
  'dr-name','dr-number','dr-class','dr-date',
  'dr-lambda','dr-L-1','dr-L-2','dr-L-3',
  'dr-observation','dr-q1','dr-q2','dr-q3',
];

function _reportDocRef() {
  const user = auth.currentUser;
  if (!user) return null;
  return doc(db, 'sessions', user.uid, 'diff_report', 'latest');
}

async function _saveReportData() {
  const ref = _reportDocRef();
  if (!ref) return;
  const data = { updatedAt: Timestamp.now() };
  _REPORT_FIELDS.forEach(id => {
    const el = $(id);
    if (el) data[id.replace(/-/g,'_')] = el.value;
  });
  try { await setDoc(ref, data, { merge: true }); }
  catch (e) { console.warn('보고서 저장 실패:', e); }
}

async function _loadReportData() {
  const ref = _reportDocRef();
  if (!ref) return;
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const data = snap.data();
    _REPORT_FIELDS.forEach(id => {
      const key = id.replace(/-/g,'_');
      const el = $(id);
      if (el && data[key] !== undefined) el.value = data[key];
    });
  } catch (e) { console.warn('보고서 불러오기 실패:', e); }
}

function _bindReport() {
  $('btn-dr-back').addEventListener('click', () => {
    _show('diff-analyze');
    requestAnimationFrame(() => { if (st.imgEl) _switchRun(activeKey); });
  });
  $('btn-dr-save-png')?.addEventListener('click', _downloadPng);
  $('dr-date').value = new Date().toISOString().slice(0,10);

  // 람다 변경 시 결과 업데이트
  $('dr-lambda').addEventListener('input', () => {
    const lInput = $('diff-lambda');
    if (lInput) lInput.value = $('dr-lambda').value;
    _buildReport();
  });

  // L 값 보고서 측 변경 → 분석 상태 동기화
  RUN_KEYS.forEach(k => {
    $(`dr-L-${k}`)?.addEventListener('input', e => {
      runStates[k].L_cm = e.target.value;
      if (activeKey === k) {
        const lInput = $('diff-L-input');
        if (lInput) lInput.value = e.target.value;
      }
      _buildReport();
    });
  });

  let _saveTimer = null;
  const _debouncedSave = () => { clearTimeout(_saveTimer); _saveTimer = setTimeout(_saveReportData, 1000); };
  _REPORT_FIELDS.forEach(id => {
    const el = $(id);
    el?.addEventListener('input',  _debouncedSave);
    el?.addEventListener('change', _debouncedSave);
  });
}

function _buildReport() {
  const lambda = parseFloat($('dr-lambda')?.value) || 650;
  const srBody = $('dr-body');
  const bodyW  = srBody ? srBody.clientWidth - 28 : 600;
  const REPORT_W = Math.max(400, bodyW);

  let dValues = [];

  RUN_KEYS.forEach(k => {
    const sData = runStates[k];
    const block = $(`dr-block-${k}`);
    if (!sData.imgEl) { block?.classList.add('hidden'); return; }
    block?.classList.remove('hidden');

    // L 값 sync (보고서 필드 → 분석 상태)
    const drL = $(`dr-L-${k}`);
    if (drL && drL.value) sData.L_cm = drL.value;
    else if (sData.L_cm) { if (drL) drL.value = sData.L_cm; }

    // 무늬 이미지 (스캔 띠 크롭)
    const imgCanvas = $(`dr-img-${k}`);
    const natW = sData.imgEl.naturalWidth;
    const natH = sData.imgEl.naturalHeight;
    const canvasH  = sData.canvasH || natH;
    const natScanY = Math.round(sData.scanY * natH / canvasH);
    const STRIP_NAT = 120, STRIP_DEST = 80;
    const srcY = Math.max(0, natScanY - Math.round(STRIP_NAT/2));
    const srcH = Math.min(STRIP_NAT, natH - srcY);
    imgCanvas.width  = REPORT_W;
    imgCanvas.height = STRIP_DEST;
    imgCanvas.style.width  = '100%';
    imgCanvas.style.height = STRIP_DEST + 'px';

    const ictx = imgCanvas.getContext('2d');
    if (sData.autoEnhance && sData._enhancedCanvas && sData.canvasH) {
      const ecScanY = sData.scanY;
      const ecStripH = Math.round(STRIP_NAT * sData.canvasH / natH);
      const ecSrcY  = Math.max(0, ecScanY - Math.round(ecStripH/2));
      const ecSrcH  = Math.min(ecStripH, sData.canvasH - ecSrcY);
      ictx.drawImage(sData._enhancedCanvas, 0, ecSrcY, sData.canvasW, ecSrcH, 0, 0, REPORT_W, STRIP_DEST);
    } else {
      ictx.drawImage(sData.imgEl, 0, srcY, natW, srcH, 0, 0, REPORT_W, STRIP_DEST);
    }
    const fringeScale = REPORT_W / (sData.canvasW || natW);
    sData.fringes.forEach((f, i) => {
      const px = Math.round(f.xPx * fringeScale);
      const isCenter = i===sData.centerIdx;
      ictx.strokeStyle = isCenter?'#ff6b35':'rgba(170,170,255,0.85)';
      ictx.lineWidth = isCenter?2:1;
      ictx.setLineDash([4,3]);
      ictx.beginPath(); ictx.moveTo(px,0); ictx.lineTo(px,STRIP_DEST); ictx.stroke();
      ictx.setLineDash([]);
    });

    // 밝기 그래프
    const REPORT_BRIGHT_H = 110;
    const brightC = $(`dr-bright-${k}`);
    brightC.width  = REPORT_W;
    brightC.height = REPORT_BRIGHT_H;
    brightC.style.width  = '100%';
    brightC.style.height = REPORT_BRIGHT_H + 'px';
    _drawBrightnessGraphTo(brightC, REPORT_W, sData);

    // y₁, d 계산
    const y1 = _calcY1(sData);
    const d  = _calcD(sData, lambda);

    const y1El = $(`dr-y1-${k}`);
    if (y1El) y1El.textContent = y1 && sData.calib.isCalibrated ? `${y1.avg.toFixed(3)} cm` : '--';
    const dEl = $(`dr-d-${k}`);
    if (dEl) dEl.textContent = d !== null ? `${d.toFixed(2)} μm` : '--';

    if (d !== null) dValues.push(d);
  });

  // 평균 및 불확도
  const avgEl   = $('dr-d-avg');
  const stdEl   = $('dr-d-std');
  const tableEl = $('dr-summary-table');
  if (dValues.length > 0) {
    const avg = dValues.reduce((a,b)=>a+b,0)/dValues.length;
    const std = dValues.length > 1
      ? Math.sqrt(dValues.reduce((a,v)=>a+(v-avg)**2,0)/(dValues.length-1))
      : 0;
    if (avgEl) avgEl.textContent = `${avg.toFixed(2)} μm`;
    if (stdEl) stdEl.textContent = dValues.length > 1 ? `± ${std.toFixed(2)} μm` : '';
  } else {
    if (avgEl) avgEl.textContent = '--';
    if (stdEl) stdEl.textContent = '';
  }
}

function _drawBrightnessGraphTo(targetCanvas, targetW, sData) {
  if (!sData.imgEl) return;
  const bh = targetCanvas.height, bw = targetW;
  const ch = sData.colorChannel || 'lum';
  const oc = document.createElement('canvas');
  oc.width = bw;
  oc.height = Math.round(sData.imgEl.naturalHeight * bw / sData.imgEl.naturalWidth);
  oc.getContext('2d').drawImage(sData.imgEl, 0, 0, bw, oc.height);
  const natH2 = sData.canvasH || sData.imgEl.naturalHeight || oc.height;
  const scanY = Math.max(0, Math.min(oc.height-1, Math.round(sData.scanY * oc.height / natH2)));
  const bandH2 = Math.max(1, Math.round((sData.scanBandH||20) * oc.height / natH2));
  const sy1 = Math.max(0, scanY-bandH2), sy2 = Math.min(oc.height-1, scanY+bandH2);
  const rows = sy2-sy1+1;
  const d = oc.getContext('2d').getImageData(0, sy1, bw, rows).data;
  const bright = new Float32Array(bw);
  for (let x=0; x<bw; x++) {
    let maxVal=0;
    for (let r=0; r<rows; r++) {
      const idx=(r*bw+x)*4;
      let val;
      if      (ch==='R') val=Math.max(0,d[idx]-Math.max(d[idx+1],d[idx+2]));
      else if (ch==='G') val=Math.max(0,d[idx+1]-Math.max(d[idx],d[idx+2]));
      else               val=d[idx]*0.299+d[idx+1]*0.587+d[idx+2]*0.114;
      if (val>maxVal) maxVal=val;
    }
    bright[x]=maxVal;
  }
  const smoothed = _gaussSmooth(bright, 2.5);
  const scaledW = sData.canvasW || sData.imgEl.naturalWidth || bw;
  const xScale  = bw / scaledW;
  let cropX0=0, cropX1=-1;
  if (sData.fringes.length > 0) {
    const fXs = sData.fringes.map(f=>Math.round(f.xPx*xScale));
    const minX=Math.min(...fXs), maxX=Math.max(...fXs);
    const span=Math.max(maxX-minX,20);
    const margin=Math.max(Math.round(span*0.4),40);
    cropX0=Math.max(0,minX-margin);
    cropX1=Math.min(bw-1,maxX+margin);
  }
  _drawBrightCore(targetCanvas.getContext('2d'), bw, bh, smoothed, sData.fringes, sData.centerIdx, -1, xScale, cropX0, cropX1, ch);
}

// ── PNG 저장 ──────────────────────────────────────────────
async function _downloadPng() {
  const btn = $('btn-dr-save-png');
  if (btn) { btn.disabled=true; btn.textContent='⏳ 생성 중…'; }
  try {
    const body = $('dr-body');
    const clone = body.cloneNode(true);
    const origCanvases  = Array.from(body.querySelectorAll('canvas'));
    const cloneCanvases = Array.from(clone.querySelectorAll('canvas'));
    const origInputs    = Array.from(body.querySelectorAll('input'));
    const cloneInputs   = Array.from(clone.querySelectorAll('input'));
    const origTAs       = Array.from(body.querySelectorAll('textarea'));
    const cloneTAs      = Array.from(clone.querySelectorAll('textarea'));

    let hasTaintedCanvas = false;
    origCanvases.forEach((cv, i) => {
      const cloneCv = cloneCanvases[i];
      if (!cloneCv) return;
      const img = document.createElement('img');
      try {
        img.src = cv.toDataURL('image/png');
      } catch (e) {
        hasTaintedCanvas = true;
        img.style.cssText += ';background:#eee;min-height:40px;';
      }
      img.className = cv.className;
      img.style.cssText = (img.style.cssText || '') + cv.style.cssText + ';display:block;max-width:100%;';
      cloneCv.replaceWith(img);
    });
    if (hasTaintedCanvas) {
      alert('⚠️ 저장된 실험에서 불러온 이미지를 PNG에 포함할 수 없습니다.\n\nFirebase Storage 규칙에 diff/ 경로를 추가하거나,\n사진을 직접 업로드한 뒤 다시 시도하세요.');
    }

    clone.style.cssText = 'background:#fff;color:#1a1a2e;padding:20px;max-width:none;width:800px;' +
      '--bg:#fff;--bg-surface:#f4f6fa;--bg-card:#f4f6fa;--text:#1a1a2e;--text-dim:#555;--border:#ccc;';
    clone.querySelectorAll('*').forEach(el => { el.style.color = '#1a1a2e'; });
    clone.querySelectorAll('.sr-slit-block,.sr-section,.sr-header-section,.dr-section,.dr-block').forEach(el => {
      el.style.background='#f4f6fa'; el.style.border='1px solid #ccc';
    });

    origInputs.forEach((el, i) => {
      const ci = cloneInputs[i];
      if (!ci) return;
      const div = document.createElement('div');
      div.className = ci.className;
      div.textContent = el.value || el.placeholder || '';
      div.style.cssText = 'border:1px solid #aaa;border-radius:3px;padding:4px 6px;background:#fff!important;color:#1a1a2e!important;font-size:13px;font-family:inherit;display:block;width:100%;box-sizing:border-box;min-height:26px;line-height:1.5;';
      ci.replaceWith(div);
    });
    origTAs.forEach((ta, i) => {
      const cta = cloneTAs[i];
      if (!cta) return;
      const div = document.createElement('div');
      div.style.cssText = 'white-space:pre-wrap;word-break:break-word;border:1px solid #aaa;border-radius:4px;padding:6px 8px;background:#fff!important;color:#1a1a2e!important;font-size:13px;font-family:inherit;line-height:1.6;min-height:40px;width:100%;box-sizing:border-box;display:block;';
      div.textContent = ta.value || '';
      cta.replaceWith(div);
    });

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;background:#fff;';
    wrapper.appendChild(clone);
    document.body.appendChild(wrapper);

    const rendered = await html2canvas(clone, { scale:2, useCORS:true, backgroundColor:'#ffffff', logging:false, width:800 });
    document.body.removeChild(wrapper);

    const num  = $('dr-number')?.value?.trim() || '';
    const name = $('dr-name')?.value?.trim()   || '';
    const suffix = num + name;
    const link = document.createElement('a');
    link.download = (suffix ? `회절_보고서_${suffix}` : '회절_보고서') + '.png';
    link.href = rendered.toDataURL('image/png');
    link.click();
  } catch (e) {
    console.error('PNG 저장 오류:', e);
    alert('PNG 저장 실패: ' + e.message);
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='📥 PNG 저장'; }
  }
}

// ── Firebase 실험 저장/불러오기 ───────────────────────────
function _expColRef() {
  const user = auth.currentUser;
  return user ? collection(db, 'sessions', user.uid, 'diff_experiments') : null;
}

async function _saveExperiment() {
  const user = auth.currentUser;
  if (!user) { alert('로그인이 필요합니다.'); return; }
  const btn = $('btn-diff-save-exp');
  const origText = btn?.textContent || '💾 저장';
  if (btn) { btn.disabled=true; btn.textContent='💾 저장 중…'; }

  try {
    const expId = _currentExpId || `dexp_${Date.now()}`;
    const imageUrls = {};

    for (const key of RUN_KEYS) {
      const s = runStates[key];
      if (!s.imgEl) continue;
      const oc = new OffscreenCanvas(s.imgEl.naturalWidth, s.imgEl.naturalHeight);
      oc.getContext('2d').drawImage(s.imgEl, 0, 0);
      const blob = await oc.convertToBlob({ type:'image/jpeg', quality:0.80 });
      const sRef = storageRef(storage, `diff/${user.uid}/${expId}/${key}.jpg`);
      await uploadBytes(sRef, blob);
      imageUrls[key] = await getDownloadURL(sRef);
    }

    const runsData = {};
    RUN_KEYS.forEach(key => {
      const s = runStates[key];
      if (!s.imgEl) return;
      runsData[key] = {
        fringes:     s.fringes.map(f => ({ xPx: f.xPx })),
        centerIdx:   s.centerIdx,
        scanY:       s.scanY,
        scanBandH:   s.scanBandH,
        sensitivity: s.sensitivity,
        colorChannel: s.colorChannel,
        autoEnhance: s.autoEnhance,
        L_cm:        s.L_cm,
        calibPoints: s.calib.points.map(p => ({ x:p.x, y:p.y })),
        calibScale:  s.calib.scale,
        calibRealLengthCm: s.calib.realLengthCm,
        canvasW: s.canvasW || 0,
        canvasH: s.canvasH || 0,
      };
    });

    const reportData = {};
    _REPORT_FIELDS.forEach(id => {
      const el = $(id);
      if (el) reportData[id.replace(/-/g,'_')] = el.value;
    });

    const name = $('dr-name')?.value?.trim() || '';
    const num  = $('dr-number')?.value?.trim() || '';
    const payload = {
      expId, imageUrls, runs: runsData, reportData,
      name: [num, name, new Date().toLocaleDateString('ko-KR')].filter(Boolean).join(' ') || `실험 ${new Date().toLocaleDateString('ko-KR')}`,
      updatedAt: Timestamp.now(),
    };

    if (_currentExpDocId) {
      payload.createdAt = _currentExpCreatedAt || Timestamp.now();
      await setDoc(doc(db,'sessions',user.uid,'diff_experiments',_currentExpDocId), payload, { merge:false });
    } else {
      payload.createdAt = Timestamp.now();
      const docRef = await addDoc(_expColRef(), payload);
      _currentExpDocId     = docRef.id;
      _currentExpId        = expId;
      _currentExpCreatedAt = payload.createdAt;
    }
    alert('✅ 실험이 저장되었습니다!');
    _refreshExperimentList();
  } catch (e) {
    console.error('실험 저장 실패:', e);
    alert('저장 실패: ' + (e?.message || String(e)));
  } finally {
    if (btn) { btn.disabled=false; btn.textContent=origText; }
  }
}

async function _listExperiments() {
  const colRef = _expColRef();
  if (!colRef) return [];
  try {
    const snap = await getDocs(colRef);
    const docs = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    // createdAt 없는 문서도 포함되도록 클라이언트 정렬
    docs.sort((a, b) => {
      const ta = a.createdAt?.toMillis?.() ?? 0;
      const tb = b.createdAt?.toMillis?.() ?? 0;
      return tb - ta;
    });
    return docs;
  } catch { return []; }
}

async function _loadExperiment(expDoc) {
  if (!confirm(`"${expDoc.name}" 실험을 불러오시겠습니까?\n현재 데이터는 초기화됩니다.`)) return;
  const btn = document.querySelector(`[data-load-id="${expDoc.id}"]`);
  if (btn) { btn.disabled=true; btn.textContent='⏳'; }
  const blobUrls = [];
  try {
    RUN_KEYS.forEach(k => { runStates[k] = _mkState(k); });
    for (const key of RUN_KEYS) {
      const runData = expDoc.runs?.[key];
      const imgUrl  = expDoc.imageUrls?.[key];
      if (!runData || !imgUrl) continue;
      let srcUrl;
      try {
        const res = await fetch(imgUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        srcUrl = URL.createObjectURL(blob);
        blobUrls.push(srcUrl);
      } catch { srcUrl = imgUrl; }
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.crossOrigin = 'anonymous';
        el.onload  = () => resolve(el);
        el.onerror = () => reject(new Error(`이미지 로드 실패 (측정 ${key})`));
        el.src = srcUrl;
      });
      const s = runStates[key];
      s.imgEl = img; s.originalImg = img;
      s.fringes      = (runData.fringes || []).map(f => ({ xPx:f.xPx }));
      s.centerIdx    = runData.centerIdx  ?? -1;
      s.scanY        = runData.scanY      ?? 0;
      s.scanBandH    = runData.scanBandH  ?? 20;
      s.sensitivity  = runData.sensitivity ?? 25;
      s.colorChannel = runData.colorChannel ?? 'lum';
      s.autoEnhance  = runData.autoEnhance ?? true;
      s.L_cm         = runData.L_cm       ?? '';
      s.canvasW      = runData.canvasW    || 0;
      s.canvasH      = runData.canvasH    || 0;
      if (runData.calibPoints?.length === 2) {
        s.calib.points = runData.calibPoints.map(p => ({ x:p.x, y:p.y }));
        if (runData.calibScale) {
          s.calib.scale = runData.calibScale;
          s.calib.realLengthCm = runData.calibRealLengthCm;
        }
      }
      const prev = $(`diff-preview-${key}`);
      if (prev) { prev.src=srcUrl; prev.classList.remove('hidden'); }
      const fnEl = $(`diff-filename-${key}`);
      if (fnEl) fnEl.textContent = `✓ ${expDoc.name} (${key})`;
      $(`diff-ucard-${key}`)?.classList.add('slit-ucard-loaded');
    }

    if (expDoc.reportData) {
      _REPORT_FIELDS.forEach(id => {
        const key = id.replace(/-/g,'_');
        const el = $(id);
        if (el && expDoc.reportData[key] !== undefined) el.value = expDoc.reportData[key];
      });
    }
    $('btn-diff-start').disabled = !RUN_KEYS.some(k => runStates[k].imgEl);
    _currentExpDocId     = expDoc.id;
    _currentExpId        = expDoc.expId;
    _currentExpCreatedAt = expDoc.createdAt || null;
    alert(`✅ "${expDoc.name}" 실험을 불러왔습니다.`);
  } catch (e) {
    blobUrls.forEach(u => URL.revokeObjectURL(u));
    alert('불러오기 실패: ' + (e?.message || String(e)));
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='불러오기'; }
  }
}

async function _deleteExperiment(expDoc) {
  if (!confirm(`"${expDoc.name}" 실험을 삭제하시겠습니까?`)) return;
  const user = auth.currentUser;
  if (!user) return;
  try {
    for (const key of RUN_KEYS) {
      if (!expDoc.imageUrls?.[key]) continue;
      try { await deleteObject(storageRef(storage, `diff/${user.uid}/${expDoc.expId}/${key}.jpg`)); } catch {}
    }
    await deleteDoc(doc(db,'sessions',user.uid,'diff_experiments',expDoc.id));
    await _refreshExperimentList();
  } catch (e) { alert('삭제 실패: ' + (e?.message || String(e))); }
}

async function _refreshExperimentList() {
  const loading = $('diff-exp-loading');
  const section = $('diff-saved-experiments');
  const listEl  = $('diff-exp-list');
  if (!listEl) return;
  if (loading) loading.classList.remove('hidden');
  if (section) section.classList.add('hidden');
  const experiments = await _listExperiments();
  if (loading) loading.classList.add('hidden');
  if (!experiments.length) { if (section) section.classList.add('hidden'); return; }
  listEl.innerHTML = '';
  experiments.forEach(exp => {
    const createdAt = exp.createdAt?.toDate?.()?.toLocaleString('ko-KR') || '';
    const row = document.createElement('div');
    row.className = 'slit-exp-item';
    row.innerHTML = `
      <div class="slit-exp-info">
        <span class="slit-exp-name">${exp.name}</span>
        <span class="slit-exp-meta">${createdAt}</span>
      </div>
      <div class="slit-exp-actions">
        <button class="btn-ghost slit-exp-load-btn" data-load-id="${exp.id}" style="min-height:30px;font-size:12px;padding:0 10px;">불러오기</button>
        <button class="btn-ghost slit-exp-del-btn" data-del-id="${exp.id}" style="min-height:30px;font-size:12px;padding:0 8px;color:#f47;border-color:#f47;">삭제</button>
      </div>`;
    row.querySelector('.slit-exp-load-btn').addEventListener('click', () => _loadExperiment(exp));
    row.querySelector('.slit-exp-del-btn').addEventListener('click', () => _deleteExperiment(exp));
    listEl.appendChild(row);
  });
  if (section) section.classList.remove('hidden');
}
