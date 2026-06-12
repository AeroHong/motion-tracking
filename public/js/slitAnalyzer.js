// slitAnalyzer.js — 이중슬릿 간섭무늬 분석 (슬릿 A / B / C)

import { Calibration }      from './calibration.js';
import { ZoomController }   from './zoomController.js';
import { pickImageFromDrive } from './drivePicker.js';
import { auth, db, storage } from './auth.js';
import { doc, getDoc, setDoc, Timestamp, collection, addDoc, getDocs, deleteDoc, query, orderBy }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

const $ = id => document.getElementById(id);

let BRIGHT_H    = 220;  // 밝기 그래프 높이 (반응형, _fitCanvas에서 갱신)
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
let _currentExpDocId = null;   // 현재 세션의 저장된 실험 문서 ID (덮어쓰기용)
let _currentExpId    = null;   // 현재 세션의 expId (Storage 경로용)

// 밝기 그래프 가로 줌/패닝 뷰포트 (0..1 범위)
const brightVP = { scale: 1, offset: 0, dragX: null, dragOff: 0 };

// 무늬 추가 모드에서 호버 위치 (canvas 좌표계 x, null이면 표시 안 함)
let hoverX = null;
// 터치/드래그 배치 중인 미확정 무늬 x (null이면 없음)
let pendingFringeX = null;

export function refreshSlitExperiments() { _refreshExperimentList(); }

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

  // 로그인 후 업로드 화면 진입 시 실험 목록 로드
  auth.onAuthStateChanged(user => {
    if (user) _refreshExperimentList();
  });
}

// ── 업로드 화면 ──────────────────────────────────────────
function _bindUpload() {
  $('btn-slit-back').addEventListener('click', () => _show('mode'));
  $('btn-slit-exp-refresh')?.addEventListener('click', _refreshExperimentList);

  SLIT_KEYS.forEach(k => {
    const fileInput = $(`slit-file-${k}`);
    $(`slit-ucard-${k}`).querySelector('.slit-pick-btn')
      .addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      const f = e.target.files[0];
      if (f) _loadImage(k, f);
      e.target.value = '';
    });

    // 구글 드라이브에서 이미지 선택
    const driveBtn = $(`slit-ucard-${k}`).querySelector('.slit-drive-btn');
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

  $('btn-slit-start').addEventListener('click', () => {
    // 이미지 있는 첫 번째 슬릿을 기본 활성화
    const firstKey = SLIT_KEYS.find(k => slitStates[k].imgEl);
    if (!firstKey) return;
    _show('slit-analyze');
    _initTabs();
    _switchSlit(firstKey);
  });
}

async function _loadImage(key, file) {
  let targetFile = file;

  // HEIC/HEIF 감지 → JPEG 변환
  const isHeic = file.type === 'image/heic' || file.type === 'image/heif' ||
                 /\.(heic|heif)$/i.test(file.name);
  if (isHeic) {
    $(`slit-filename-${key}`).textContent = '⏳ HEIC 변환 중…';
    try {
      const converted = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
      const blob = Array.isArray(converted) ? converted[0] : converted;
      targetFile = new File([blob], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' });
    } catch (e) {
      console.error('HEIC 변환 실패:', e);
      $(`slit-filename-${key}`).textContent = '❌ HEIC 변환 실패 — JPEG로 저장 후 업로드하세요';
      return;
    }
  }

  const url = URL.createObjectURL(targetFile);
  const img = new Image();
  img.onload = () => {
    const s = slitStates[key];
    _resetAnalysis(s);          // 분석 데이터 초기화
    s.imgEl      = img;
    s.originalImg = img;        // 원본 보존
    s.editParams  = null;       // 편집 파라미터 초기화
    // 새 이미지 업로드 → 새 실험으로 간주하고 세션 ID 초기화
    _currentExpDocId = null;
    _currentExpId    = null;
    const prev = $(`slit-preview-${key}`);
    prev.src = url;
    prev.classList.remove('hidden');
    $(`slit-filename-${key}`).textContent = `✓ ${targetFile.name}`;
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
  $('btn-slit-save-exp')?.addEventListener('click', _saveExperiment);
  $('btn-slit-report').addEventListener('click', () => {
    _show('slit-report');
    requestAnimationFrame(() => {
      _buildReport();
      _loadReportData();
    });
  });

  $('slit-btn-pan').addEventListener('click',         () => _setMode('pan'));
  $('slit-btn-calibration').addEventListener('click', () => _setMode('calibration'));
  $('slit-btn-add').addEventListener('click',         () => _setMode('add'));
  $('slit-btn-drag').addEventListener('click',        () => _setMode('drag'));
  $('slit-btn-setcenter').addEventListener('click',   () => _setMode('setcenter'));
  $('slit-btn-detect').addEventListener('click',      _autoDetect);

  $('slit-btn-clear').addEventListener('click', () => {
    st.fringes = []; st.centerIdx = -1; st.selectedIdx = -1;
    _render(); _drawBrightnessGraph(); _updateFringeList(); _updateResults();
  });

  $('slit-calib-ok').addEventListener('click', _applyCalib);
  $('slit-calib-value').addEventListener('keydown', e => { if (e.key === 'Enter') _applyCalib(); });

  // ── 너지 버튼 (선택된 무늬 좌우 미세 이동) ──────────────
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
  $('nudge-ll')?.addEventListener('click', () => _nudge(-5));
  $('nudge-l')?.addEventListener('click',  () => _nudge(-1));
  $('nudge-r')?.addEventListener('click',  () => _nudge( 1));
  $('nudge-rr')?.addEventListener('click', () => _nudge( 5));
  $('nudge-del')?.addEventListener('click', () => {
    if (st.selectedIdx >= 0) { _deleteFringe(st.selectedIdx); _render(); _drawBrightnessGraph(); _updateFringeList(); _updateResults(); }
  });

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
  // 화면 크기에 따라 그래프 높이 조정
  const h = window.innerHeight;
  BRIGHT_H = h < 700 ? 70 : h < 900 ? 85 : 100;

  const wrap = $('slit-canvas-wrap');
  const maxW = Math.max(100, (wrap?.offsetWidth  || 700) - 2);
  const maxH = Math.max(100, (wrap?.offsetHeight || 500) - 2 - LABEL_AREA_H);
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
  const prevW = st.canvasW || 0;
  const prevH = st.canvasH || 0;
  st.canvasW = imgW;
  st.canvasH = imgH;

  // 캔버스 크기가 바뀌면 저장된 좌표를 비례 보정
  // (화면 크기 변화 또는 저장 후 다른 화면에서 불러올 때 모두 처리)
  if (prevW > 0 && prevH > 0 && (prevW !== imgW || prevH !== imgH)) {
    const sx = imgW / prevW;
    const sy = imgH / prevH;
    st.fringes.forEach(f => { f.xPx = f.xPx * sx; });
    st.scanY = st.scanY * sy;
    st.calib.points.forEach(p => { p.x *= sx; p.y *= sy; });
    if (st.calib.isCalibrated) st.calib.setRealLength(st.calib.realLengthCm);
  }

  if (!st.scanY) st.scanY = Math.round(imgH / 2);
  st._enhancedCanvas = null;   // 캔버스 크기 바뀌면 캐시 무효화
}

// ── 모드 ─────────────────────────────────────────────────
function _setMode(mode) {
  st.mode = mode;
  ['pan','calibration','add','drag','setcenter'].forEach(m =>
    $(`slit-btn-${m}`)?.classList.toggle('active', m === mode)
  );
  const hints = {
    pan:         '핀치/휠로 확대 · 드래그로 이동',
    calibration: '자(ruler)의 두 점 클릭 → 실제 길이 입력',
    add:         '손 떼면 무늬 추가 확정 (누른 채 드래그로 조정)',
    drag:        '무늬 선 위에서 드래그하여 이동',
    setcenter:   '중앙 밝은 무늬(m=0)를 클릭하여 선택하세요',
  };
  $('slit-mode-hint').textContent = hints[mode] || '';
  canvas.style.cursor       = (mode === 'add' || mode === 'calibration' || mode === 'setcenter') ? 'crosshair'
                             : mode === 'drag' ? 'ew-resize' : 'grab';
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
  const oc2d = oc.getContext('2d');
  try { oc2d.drawImage(img, 0, 0, bw, imgH); } catch(e) { return null; }
  const bandH  = sData?.scanBandH ?? st.scanBandH ?? 20;
  const scanY  = Math.max(0, Math.min(imgH - 1, Math.round((sData?.scanY ?? st.scanY))));
  const sy1    = Math.max(0, scanY - bandH);
  const sy2    = Math.min(imgH - 1, scanY + bandH);
  const rows   = sy2 - sy1 + 1;
  let d; try { d = oc2d.getImageData(0, sy1, bw, rows).data; } catch(e) { return null; }
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

  // 스캔 띠 드래그 — pan 모드에서만 허용 (add/calibration 등에서 의도치 않게 스캔라인이 움직이는 문제 방지)
  if (st.mode === 'pan' && iy >= 0 && Math.abs(iy - st.scanY) <= Math.max(16, st.scanBandH || 20)) { st.isDraggingScan = true; return; }

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

  // ↔ 무늬 이동 모드: 가까운 무늬만 드래그
  if (st.mode === 'drag') {
    const nearIdx = _nearFringe(x);
    const screenToCvs = canvas.width / (canvas.getBoundingClientRect().width || canvas.width);
    const selThresh = Math.max(28 * screenToCvs / (zoom?.scale || 1), 3);
    if (nearIdx >= 0 && Math.abs(st.fringes[nearIdx].xPx - x) < selThresh) {
      st.isDraggingFringe  = true;
      st.draggingFringeIdx = nearIdx;
      st.selectedIdx       = nearIdx;
      canvas.style.cursor  = 'ew-resize';
      _render(); _drawBrightnessGraph(); _updateFringeList();
    }
    return;
  }

  if (st.mode === 'add') {
    // 드래그 배치 시작 (손 떼면 확정)
    pendingFringeX = x;
    hoverX = null;
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
  // 무늬 추가 모드: 드래그 배치 중이면 pendingFringeX 업데이트, 아니면 호버 미리보기
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
  // 드래그 배치 확정
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

// 드래그 배치 중인 미확정 무늬 — 실선 노란색 + "손 떼면 확정" 레이블
function _drawPendingFringe(x) {
  const px = 1 / (zoom?.scale || 1);
  ctx.save();
  // 외곽 어두운 선 (배경 대비)
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth   = px * 4;
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(x, LABEL_AREA_H); ctx.lineTo(x, canvas.height); ctx.stroke();
  // 밝은 노란색 실선
  ctx.strokeStyle = '#ffe066';
  ctx.lineWidth   = px * 2;
  ctx.beginPath(); ctx.moveTo(x, LABEL_AREA_H); ctx.lineTo(x, canvas.height); ctx.stroke();
  // 상단 삼각형 포인터
  const ty = LABEL_AREA_H + 4;
  const s  = 8 * px;
  ctx.fillStyle = '#ffe066';
  ctx.beginPath(); ctx.moveTo(x, ty + s); ctx.lineTo(x - s * 0.65, ty); ctx.lineTo(x + s * 0.65, ty); ctx.closePath(); ctx.fill();
  // "손 떼면 확정" 안내 레이블
  const label = '손 떼면 확정';
  ctx.font = `bold ${Math.round(11 * px)}px sans-serif`;
  const tw = ctx.measureText(label).width + 10 * px;
  let lx = x + 8 * px;
  if (lx + tw > canvas.width) lx = x - tw - 8 * px;
  const ly = LABEL_AREA_H + 28 * px;
  ctx.fillStyle = 'rgba(15,25,50,0.88)';
  if (ctx.roundRect) ctx.roundRect(lx - 2*px, ly - 13*px, tw, 17*px, 3);
  else ctx.rect(lx - 2*px, ly - 13*px, tw, 17*px);
  ctx.fill();
  ctx.fillStyle = '#ffe066';
  ctx.textAlign = 'left';
  ctx.fillText(label, lx + 3*px, ly);
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

    // 드래그 핸들: drag 모드 또는 이동 중에 이미지 상단에 원형 핸들 표시
    if (st.mode === 'drag' || (st.isDraggingFringe && st.draggingFringeIdx === i)) {
      const hY = LABEL_AREA_H + 8;
      const hr = Math.max(5, 6 * px);
      ctx.fillStyle = isSel ? '#00e5ff' : isCenter ? '#ff6b35' : 'rgba(0,207,255,0.75)';
      ctx.beginPath();
      ctx.arc(f.xPx, hY, hr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = px;
      ctx.setLineDash([]);
      ctx.stroke();
      // 좌우 화살표 표시
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(Math.max(8, 8 * px))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('↔', f.xPx, hY);
    }

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

  // 드래그 배치 중 pending 선 (무늬 추가 모드, 현재 슬릿만)
  if (pendingFringeX !== null && st.mode === 'add' && (!sData || sData === st)) {
    const graphH   = bh - SPECTRUM_H;
    const hasCrop2 = cropX1 >= 0;
    const pSrc     = Math.round(pendingFringeX * fXScale);
    const cropW2   = hasCrop2 ? Math.max(1, cropX1 - cropX0 + 1) : bw;
    const pGX      = hasCrop2
      ? Math.round((pSrc - cropX0) / cropW2 * bw)
      : Math.round(pendingFringeX * bw / (canvas.width || bw));
    if (pGX >= 0 && pGX <= bw) {
      bctx.save();
      bctx.strokeStyle = 'rgba(0,0,0,0.5)';
      bctx.lineWidth   = 3;
      bctx.setLineDash([]);
      bctx.beginPath(); bctx.moveTo(pGX, 0); bctx.lineTo(pGX, graphH); bctx.stroke();
      bctx.strokeStyle = '#ffe066';
      bctx.lineWidth   = 1.5;
      bctx.beginPath(); bctx.moveTo(pGX, 0); bctx.lineTo(pGX, graphH); bctx.stroke();
      bctx.restore();
    }
  }
  // 호버 미리보기선 (무늬 추가 모드, 현재 슬릿만)
  if (pendingFringeX === null && hoverX !== null && st.mode === 'add' && (!sData || sData === st)) {
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
  try { oc2.drawImage(img, 0, 0, dw, dh); } catch(e) { sData._enhancedCanvas = null; return; }

  if (ch === 'R' || ch === 'G') {
    // 채널 신호 추출: 순수 색상 성분 + 백색도 → 포화된 흰 중앙도 최대값 유지
    let full; try { full = oc2.getImageData(0, 0, dw, dh); } catch(e) { sData._enhancedCanvas = null; return; }
    const d    = full.data;
    const sigs = new Float32Array(d.length >> 2);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      // 순수 색상 성분 + 백색도(포화된 흰 중앙도 최대값으로 인식)
      const sat = Math.min(d[i], d[i+1], d[i+2]);
      sigs[j] = ch === 'R'
        ? Math.max(0, d[i]   - Math.max(d[i+1], d[i+2])) + sat
        : Math.max(0, d[i+1] - Math.max(d[i],   d[i+2])) + sat;
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
  let strip; try { strip = oc2.getImageData(0, sy1, dw, sy2 - sy1 + 1).data; } catch(e) { sData._enhancedCanvas = null; return; }
  const lums  = new Float32Array(strip.length >> 2);
  for (let i = 0, j = 0; i < strip.length; i += 4, j++)
    lums[j] = strip[i] * 0.299 + strip[i+1] * 0.587 + strip[i+2] * 0.114;
  lums.sort();
  const lo = lums[Math.floor(lums.length * 0.02)] ?? 0;
  const hi = lums[Math.floor(lums.length * 0.98)] ?? 255;

  if (hi - lo >= 200) { sData._enhancedCanvas = oc; return; }  // 이미 충분한 대비

  let full2; try { full2 = oc2.getImageData(0, 0, dw, dh); } catch(e) { sData._enhancedCanvas = null; return; }
  const full = full2;
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

  // 너지 바 표시/숨김
  const nudgeBar = $('slit-nudge-bar');
  if (nudgeBar) {
    const hasSel = st.selectedIdx >= 0 && st.selectedIdx < st.fringes.length;
    nudgeBar.classList.toggle('hidden', !hasSel);
    if (hasSel) {
      const lbl = $('nudge-fringe-label');
      if (lbl) {
        const order = _getOrder(st.selectedIdx);
        lbl.textContent = order === 0 ? '중앙 무늬' : order !== null ? `m=${order>0?'+':''}${order}` : `무늬 ${st.selectedIdx+1}`;
      }
    }
  }

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

// ── 보고서 DB 저장/불러오기 ──────────────────────────────────
const _REPORT_FIELDS = [
  'sr-name', 'sr-number', 'sr-class', 'sr-date',
  'sr-L',
  'sr-d-A', 'sr-d-B', 'sr-d-C',
  'sr-lambda-A', 'sr-lambda-B', 'sr-lambda-C',
  'sr-observation', 'sr-q1', 'sr-q2', 'sr-q3',
];

function _reportDocRef() {
  const user = auth.currentUser;
  if (!user) return null;
  return doc(db, 'sessions', user.uid, 'slit_report', 'latest');
}

async function _saveReportData() {
  const ref = _reportDocRef();
  if (!ref) return;
  const data = { updatedAt: Timestamp.now() };
  _REPORT_FIELDS.forEach(id => {
    const el = $(id);
    if (el) data[id.replace(/-/g, '_')] = el.value;
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
      const key = id.replace(/-/g, '_');
      const el = $(id);
      if (el && data[key] !== undefined) el.value = data[key];
    });
  } catch (e) { console.warn('보고서 불러오기 실패:', e); }
}

// ── 파일명 헬퍼 ──────────────────────────────────────────
function _getReportFilename() {
  const num  = $('sr-number')?.value?.trim() || '';
  const name = $('sr-name')?.value?.trim() || '';
  const suffix = num + name;   // 예: "10101홍길동"
  return suffix ? `이중슬릿_보고서_${suffix}` : '이중슬릿_보고서';
}

// ── PNG 저장 (html2canvas 기반 — Android 포함 전 기기 동작) ──
async function _downloadPng() {
  const btn = $('btn-sr-save-png');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 생성 중…'; }

  try {
    const body = $('sr-body');
    const clone = body.cloneNode(true);

    // 모든 스냅샷을 replaceWith 전에 취함
    const origCanvases = Array.from(body.querySelectorAll('canvas'));
    const cloneCanvases = Array.from(clone.querySelectorAll('canvas'));
    const origInputs    = Array.from(body.querySelectorAll('input'));
    const cloneInputs   = Array.from(clone.querySelectorAll('input'));
    const origTAs       = Array.from(body.querySelectorAll('textarea'));
    const cloneTAs      = Array.from(clone.querySelectorAll('textarea'));

    // 1. canvas → img
    origCanvases.forEach((cv, i) => {
      const cloneCv = cloneCanvases[i];
      if (!cloneCv) return;
      const img = document.createElement('img');
      try { img.src = cv.toDataURL('image/png'); } catch (_) {}
      img.className = cv.className;
      img.style.cssText = cv.style.cssText + ';display:block;max-width:100%;';
      cloneCv.replaceWith(img);
    });

    // 2. 라이트 테마 먼저 적용 (이후 교체 div 인라인 스타일로 덮어쓸 수 있도록)
    clone.style.cssText = 'background:#fff;color:#1a1a2e;padding:20px;max-width:none;width:800px;' +
      '--bg:#fff;--bg-surface:#f4f6fa;--bg-card:#f4f6fa;--text:#1a1a2e;--text-dim:#555;--border:#ccc;';
    clone.querySelectorAll('*').forEach(el => { el.style.color = '#1a1a2e'; });
    clone.querySelectorAll('.sr-slit-block,.sr-section,.sr-header-section').forEach(el => {
      el.style.background = '#f4f6fa';
      el.style.border = '1px solid #ccc';
    });
    clone.querySelectorAll('.sr-slit-title,.sr-img-label,.sr-q-label,.sr-dy-row,.sr-dy-val').forEach(el => {
      el.style.color = '#1a1a2e';
    });

    // 3. input → div 교체 (html2canvas는 input 내부 텍스트를 width로 잘라냄)
    origInputs.forEach((el, i) => {
      const ci = cloneInputs[i];
      if (!ci) return;
      const div = document.createElement('div');
      div.className = ci.className;
      const hasVal = el.value !== '';
      div.textContent = hasVal ? el.value : (el.placeholder || '');
      div.style.cssText =
        'border:1px solid #aaa;border-radius:3px;padding:4px 6px;' +
        'background:#fff!important;' +
        (hasVal ? 'color:#1a1a2e!important;' : 'color:#999!important;') +
        'font-size:13px;font-family:inherit;display:block;' +
        'width:100%;box-sizing:border-box;min-height:26px;line-height:1.5;' +
        'white-space:nowrap;overflow:visible;';
      ci.replaceWith(div);
    });

    // 4. textarea → div 교체 (높이 자동 확장 + 줄바꿈 보존)
    origTAs.forEach((ta, i) => {
      const cta = cloneTAs[i];
      if (!cta) return;
      const div = document.createElement('div');
      div.className = cta.className;
      div.style.cssText =
        'white-space:pre-wrap;word-break:break-word;border:1px solid #aaa;border-radius:4px;' +
        'padding:6px 8px;background:#fff!important;color:#1a1a2e!important;' +
        'font-size:13px;font-family:inherit;line-height:1.6;' +
        'min-height:40px;width:100%;box-sizing:border-box;display:block;';
      div.textContent = ta.value || '';
      cta.replaceWith(div);
    });

    // 5. 화면 밖 배치 후 렌더
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;background:#fff;';
    wrapper.appendChild(clone);
    document.body.appendChild(wrapper);

    const rendered = await html2canvas(clone, {
      scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false, width: 800,
    });
    document.body.removeChild(wrapper);

    const link = document.createElement('a');
    link.download = _getReportFilename() + '.png';
    link.href = rendered.toDataURL('image/png');
    link.click();

  } catch (e) {
    console.error('PNG 저장 오류:', e);
    alert('PNG 저장 실패: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📥 PNG 저장'; }
  }
}

// ── DOCX 저장 (JSZip 기반 Open XML 직접 생성) ─────────────
async function _downloadDocx() {
  const btn = $('btn-sr-save-docx');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 생성 중…'; }

  try {
    // JSZip 지연 로딩
    if (!window.JSZip) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('JSZip 로드 실패'));
        document.head.appendChild(s);
      });
    }

    const zip = new window.JSZip();
    const val = id => $(id)?.value?.trim() || '';
    const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // canvas → base64 PNG 수집
    const imgs = [];
    function collectImg(canvas) {
      if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
      const rId = `rId${imgs.length + 1}`;
      imgs.push({ rId, b64: canvas.toDataURL('image/png').split(',')[1], width: canvas.width, height: canvas.height });
      return rId;
    }

    const slitSecs = [];
    for (const key of SLIT_KEYS) {
      if (!slitStates[key].imgEl) continue;
      slitSecs.push({
        key,
        imgRId:    collectImg($(`sr-img-${key}`)),
        brightRId: collectImg($(`sr-bright-${key}`)),
        dy:        $(`sr-dy-${key}`)?.textContent?.trim() || '--',
        d:         val(`sr-d-${key}`),
        lambda:    val(`sr-lambda-${key}`),
      });
    }

    // px → EMU (96 dpi 기준)
    const MAX_W = 480;
    const p2e = px => Math.round(px * 9525);
    function imgXml(rId, w, h) {
      const dw = Math.min(w, MAX_W), dh = Math.round(h * dw / w);
      const cx = p2e(dw), cy = p2e(dh), id = rId.replace('rId','');
      return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="img${id}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="img${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    }
    function hd(lv, text) {
      return `<w:p><w:pPr><w:pStyle w:val="Heading${lv}"/></w:pPr><w:r><w:t>${esc(text)}</w:t></w:r></w:p>`;
    }
    function para(text, bold = false) {
      return `<w:p>${text.split('\n').map((line, i) =>
        (i > 0 ? '<w:r><w:br/></w:r>' : '') +
        `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`
      ).join('')}</w:p>`;
    }
    function cell(text, bold = false) {
      return `<w:tc><w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t>${esc(text)}</w:t></w:r></w:p></w:tc>`;
    }
    const blk = () => '<w:p/>';

    const parts = [
      hd(1, '이중슬릿 간섭무늬 실험 보고서'), blk(),
      `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="888888"/><w:left w:val="single" w:sz="4" w:color="888888"/><w:bottom w:val="single" w:sz="4" w:color="888888"/><w:right w:val="single" w:sz="4" w:color="888888"/><w:insideH w:val="single" w:sz="4" w:color="888888"/><w:insideV w:val="single" w:sz="4" w:color="888888"/></w:tblBorders></w:tblPr><w:tr>${cell('이름',true)}${cell(val('sr-name'))}${cell('학번',true)}${cell(val('sr-number'))}${cell('반',true)}${cell(val('sr-class'))}${cell('날짜',true)}${cell(val('sr-date'))}</w:tr></w:tbl>`,
      blk(),
      para(`스크린까지의 거리 L = ${val('sr-L')} cm`, true), blk(),
    ];

    slitSecs.forEach(({ key, imgRId, brightRId, dy, d, lambda }) => {
      const iI = imgs.find(x => x.rId === imgRId), bI = imgs.find(x => x.rId === brightRId);
      parts.push(hd(2, `슬릿 ${key}`));
      if (imgRId    && iI) parts.push(imgXml(imgRId,    iI.width, iI.height));
      if (brightRId && bI) parts.push(imgXml(brightRId, bI.width, bI.height));
      parts.push(para(`Δy${key} = ${dy}　　d${key} = ${d} mm　　λ${key} = ${lambda} nm`));
      parts.push(blk());
    });

    parts.push(hd(2, '관찰'), para(val('sr-observation') || '(없음)'), blk(), hd(2, '고찰'));
    [['sr-q1','Q1. 슬릿 간격이 변할 때 무늬 간격은 어떻게 변하는지 서술하시오.'],
     ['sr-q2','Q2. 스크린까지의 거리 L이 늘어나면 무늬 간격은 어떻게 변할지 서술하시오.'],
     ['sr-q3','Q3. 다른 색상의 빛을 사용했을 때 무늬 간격은 어떻게 변할지 서술하시오.']].forEach(([id, q]) => {
      parts.push(para(q, true), para(val(id) || '(작성 안 됨)'), blk());
    });

    const imgRelsXml = imgs.map((img, i) =>
      `<Relationship Id="${img.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/img${i+1}.png"/>`
    ).join('');

    zip.file('[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);

    zip.file('_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);

    zip.file('word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:body></w:document>`);

    zip.file('word/_rels/document.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${imgRelsXml}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rIdSt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);

    zip.file('word/settings.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="720"/></w:settings>`);

    zip.file('word/styles.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style></w:styles>`);

    imgs.forEach((img, i) => zip.file(`word/media/img${i+1}.png`, img.b64, { base64: true }));

    const blob = await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = _getReportFilename() + '.docx';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);

  } catch (e) {
    console.error('DOCX 저장 오류:', e);
    alert('DOCX 생성 실패: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📝 DOCX'; }
  }
}

// ── 실험 저장/불러오기 ────────────────────────────────────

function _expColRef() {
  const user = auth.currentUser;
  return user ? collection(db, 'sessions', user.uid, 'slit_experiments') : null;
}

function _getExperimentName() {
  const name = $('sr-name')?.value?.trim() || '';
  const num  = $('sr-number')?.value?.trim() || '';
  const date = new Date().toLocaleDateString('ko-KR');
  return [num, name, date].filter(Boolean).join(' ') || `실험 ${date}`;
}

async function _saveExperiment() {
  const user = auth.currentUser;
  if (!user) { alert('로그인이 필요합니다.'); return; }

  const btn = $('btn-slit-save-exp');
  const origText = btn?.textContent || '💾 저장';
  if (btn) { btn.disabled = true; btn.textContent = '💾 저장 중…'; }

  try {
    // 첫 저장이면 새 ID, 이후엔 같은 ID로 덮어쓰기
    const expId = _currentExpId || `exp_${Date.now()}`;
    const imageUrls = {};

    for (const key of SLIT_KEYS) {
      const s = slitStates[key];
      if (!s.imgEl) continue;

      const oc = new OffscreenCanvas(s.imgEl.naturalWidth, s.imgEl.naturalHeight);
      oc.getContext('2d').drawImage(s.imgEl, 0, 0);
      const blob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.80 });

      // 같은 경로로 uploadBytes → Storage 파일 자동 덮어쓰기
      const sRef = storageRef(storage, `slit/${user.uid}/${expId}/${key}.jpg`);
      await uploadBytes(sRef, blob);
      imageUrls[key] = await getDownloadURL(sRef);
    }

    const slitsData = {};
    SLIT_KEYS.forEach(key => {
      const s = slitStates[key];
      if (!s.imgEl) return;
      slitsData[key] = {
        fringes: s.fringes.map(f => ({ xPx: f.xPx, label: f.label || '' })),
        centerIdx: s.centerIdx,
        scanY: s.scanY,
        scanBandH: s.scanBandH,
        sensitivity: s.sensitivity,
        colorChannel: s.colorChannel,
        autoEnhance: s.autoEnhance,
        calibPoints: s.calib.points.map(p => ({ x: p.x, y: p.y })),
        calibScale: s.calib.scale,
        calibRealLengthCm: s.calib.realLengthCm,
        canvasW: s.canvasW || 0,
        canvasH: s.canvasH || 0,
      };
    });

    const reportData = {};
    _REPORT_FIELDS.forEach(id => {
      const el = $(id);
      if (el) reportData[id.replace(/-/g, '_')] = el.value;
    });

    const payload = {
      expId,
      name: _getExperimentName(),
      updatedAt: Timestamp.now(),
      imageUrls,
      slits: slitsData,
      reportData,
    };

    if (_currentExpDocId) {
      // 기존 문서 덮어쓰기
      await setDoc(doc(db, 'sessions', user.uid, 'slit_experiments', _currentExpDocId), payload, { merge: false });
    } else {
      // 최초 저장 — 새 문서 생성
      payload.createdAt = Timestamp.now();
      const docRef = await addDoc(_expColRef(), payload);
      _currentExpDocId = docRef.id;
      _currentExpId    = expId;
    }

    alert('✅ 실험이 저장되었습니다!');
    _refreshExperimentList();

  } catch (e) {
    console.error('실험 저장 실패:', e);
    alert('저장 실패: ' + (e?.message || String(e)));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

async function _listExperiments() {
  const colRef = _expColRef();
  if (!colRef) return [];
  try {
    const q = query(colRef, orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('실험 목록 로드 실패:', e);
    return [];
  }
}

async function _loadExperiment(expDoc) {
  const confirmLoad = confirm(`"${expDoc.name}" 실험을 불러오시겠습니까?\n현재 작업 중인 데이터는 초기화됩니다.`);
  if (!confirmLoad) return;

  const btn = document.querySelector(`[data-load-id="${expDoc.id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

  const blobUrls = [];

  try {
    SLIT_KEYS.forEach(k => { slitStates[k] = _mkState(k); });

    for (const key of SLIT_KEYS) {
      const slitData = expDoc.slits?.[key];
      const imgUrl   = expDoc.imageUrls?.[key];
      if (!slitData || !imgUrl) continue;

      // fetch → blob URL (CORS 설정 후 동작, 동일출처로 변환 → canvas 작업 가능)
      let srcUrl;
      try {
        const res = await fetch(imgUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        srcUrl = URL.createObjectURL(blob);
        blobUrls.push(srcUrl);
      } catch (e) {
        console.warn(`이미지 fetch 실패 (슬릿 ${key}):`, e);
        srcUrl = imgUrl;
      }

      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload  = () => resolve(el);
        el.onerror = () => reject(new Error(`이미지 로드 실패 (슬릿 ${key})`));
        el.src = srcUrl;
      });

      const s = slitStates[key];
      s.imgEl = img;
      s.originalImg = img;

      s.fringes      = (slitData.fringes || []).map(f => ({ xPx: f.xPx, label: f.label || '' }));
      s.centerIdx    = slitData.centerIdx ?? -1;
      s.scanY        = slitData.scanY ?? 0;
      s.scanBandH    = slitData.scanBandH ?? 20;
      s.sensitivity  = slitData.sensitivity ?? 25;
      s.colorChannel = slitData.colorChannel ?? 'lum';
      s.autoEnhance  = slitData.autoEnhance ?? true;
      // 저장 당시 캔버스 크기를 복원 → _fitCanvas에서 새 크기와 비교해 좌표 비례 보정
      s.canvasW      = slitData.canvasW || 0;
      s.canvasH      = slitData.canvasH || 0;

      if (slitData.calibPoints?.length === 2) {
        s.calib.points = slitData.calibPoints.map(p => ({ x: p.x, y: p.y }));
        if (slitData.calibScale) {
          s.calib.scale = slitData.calibScale;
          s.calib.realLengthCm = slitData.calibRealLengthCm;
        }
      }

      const prev = $(`slit-preview-${key}`);
      if (prev) { prev.src = srcUrl; prev.classList.remove('hidden'); }
      const fname = $(`slit-filename-${key}`);
      if (fname) fname.textContent = `✓ ${expDoc.name} (${key})`;
      $(`slit-ucard-${key}`)?.classList.add('slit-ucard-loaded');
      $(`slit-edit-upload-${key}`)?.classList.remove('hidden');
    }

    $('btn-slit-start').disabled = !SLIT_KEYS.some(k => slitStates[k].imgEl);

    if (expDoc.reportData) {
      _REPORT_FIELDS.forEach(id => {
        const key = id.replace(/-/g, '_');
        const el = $(id);
        if (el && expDoc.reportData[key] !== undefined) el.value = expDoc.reportData[key];
      });
    }

    // 불러온 실험을 현재 세션으로 설정 → 재저장 시 같은 문서 덮어쓰기
    _currentExpDocId = expDoc.id;
    _currentExpId    = expDoc.expId;

    alert(`✅ "${expDoc.name}" 실험을 불러왔습니다.`);

  } catch (e) {
    console.error('실험 불러오기 실패:', e);
    blobUrls.forEach(u => URL.revokeObjectURL(u));
    alert('불러오기 실패: ' + (e?.message || String(e)));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '불러오기'; }
  }
}

async function _deleteExperiment(expDoc) {
  if (!confirm(`"${expDoc.name}" 실험을 삭제하시겠습니까?`)) return;
  const user = auth.currentUser;
  if (!user) return;

  try {
    // Storage 이미지 삭제
    for (const key of SLIT_KEYS) {
      if (!expDoc.imageUrls?.[key]) continue;
      try {
        await deleteObject(storageRef(storage, `slit/${user.uid}/${expDoc.expId}/${key}.jpg`));
      } catch (_) { /* 이미 없을 수 있음 */ }
    }
    // Firestore 문서 삭제
    await deleteDoc(doc(db, 'sessions', user.uid, 'slit_experiments', expDoc.id));
    await _refreshExperimentList();
  } catch (e) {
    alert('삭제 실패: ' + (e?.message || String(e)));
  }
}

async function _refreshExperimentList() {
  const loading = $('slit-exp-loading');
  const section = $('slit-saved-experiments');
  const listEl  = $('slit-exp-list');
  if (!listEl) return;

  if (loading) loading.classList.remove('hidden');
  if (section) section.classList.add('hidden');

  const experiments = await _listExperiments();

  if (loading) loading.classList.add('hidden');

  if (experiments.length === 0) {
    if (section) section.classList.add('hidden');
    return;
  }

  listEl.innerHTML = '';
  experiments.forEach(exp => {
    const createdAt = exp.createdAt?.toDate?.()?.toLocaleString('ko-KR') || '';
    const hasSlits = SLIT_KEYS.filter(k => exp.slits?.[k]).join(', ') || '-';
    const row = document.createElement('div');
    row.className = 'slit-exp-item';
    row.innerHTML = `
      <div class="slit-exp-info">
        <span class="slit-exp-name">${exp.name}</span>
        <span class="slit-exp-meta">${createdAt} &nbsp;·&nbsp; 슬릿 ${hasSlits}</span>
      </div>
      <div class="slit-exp-actions">
        <button class="btn-ghost slit-exp-load-btn" data-load-id="${exp.id}" style="min-height:30px;font-size:12px;padding:0 10px;">불러오기</button>
        <button class="btn-ghost slit-exp-del-btn" data-del-id="${exp.id}" style="min-height:30px;font-size:12px;padding:0 8px;color:#f47;border-color:#f47;">삭제</button>
      </div>
    `;
    row.querySelector('.slit-exp-load-btn').addEventListener('click', () => _loadExperiment(exp));
    row.querySelector('.slit-exp-del-btn').addEventListener('click', () => _deleteExperiment(exp));
    listEl.appendChild(row);
  });

  if (section) section.classList.remove('hidden');
}

// ── 보고서 ───────────────────────────────────────────────
function _bindReport() {
  $('btn-sr-back').addEventListener('click', () => _show('slit-analyze'));
  $('btn-sr-save').addEventListener('click', _printReport);
  $('btn-sr-save-png')?.addEventListener('click', _downloadPng);
  $('btn-sr-save-docx')?.addEventListener('click', _downloadDocx);
  $('sr-date').value = new Date().toISOString().slice(0,10);

  // 보고서 필드 변경 시 자동 저장 (1초 디바운스)
  let _saveTimer = null;
  const _debouncedSave = () => {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(_saveReportData, 1000);
  };
  _REPORT_FIELDS.forEach(id => {
    const el = $(id);
    el?.addEventListener('input',  _debouncedSave);
    el?.addEventListener('change', _debouncedSave);
  });
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

function _printReport() {
  const body = $('sr-body');
  if (!body) return;

  const btn = $('btn-sr-save');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 준비 중…'; }

  // 파일명에 학번·이름 반영 (브라우저 PDF 저장 시 제목으로 사용)
  const origTitle = document.title;
  document.title = _getReportFilename();

  try {
    const clone = body.cloneNode(true);

    // canvas → img 변환 (cloneNode된 canvas는 내용이 비어있음)
    const origCanvases  = Array.from(body.querySelectorAll('canvas'));
    const cloneCanvases = Array.from(clone.querySelectorAll('canvas'));
    origCanvases.forEach((cv, i) => {
      const cloneCv = cloneCanvases[i];
      if (!cloneCv) return;
      const img = document.createElement('img');
      try { img.src = cv.toDataURL('image/png'); } catch (_e) { /* 보안 제한 시 빈 이미지 */ }
      img.className = cv.className;
      img.style.cssText = cv.style.cssText;
      cloneCv.replaceWith(img);
    });

    // input 현재 값 복사 (cloneNode는 user-typed 값을 value 어트리뷰트에 반영하지 않음)
    const origInputs  = Array.from(body.querySelectorAll('input'));
    const cloneInputs = Array.from(clone.querySelectorAll('input'));
    origInputs.forEach((el, i) => {
      if (cloneInputs[i]) cloneInputs[i].setAttribute('value', el.value);
    });

    // textarea 내용 복사 (cloneNode는 textContent를 현재 value로 반영하지 않음)
    const origTAs  = Array.from(body.querySelectorAll('textarea'));
    const cloneTAs = Array.from(clone.querySelectorAll('textarea'));
    origTAs.forEach((ta, i) => {
      if (!cloneTAs[i]) return;
      cloneTAs[i].textContent = ta.value;
      cloneTAs[i].rows = Math.max(ta.rows, ta.value.split('\n').length + 1);
    });

    // print container를 #app 외부에 생성
    let container = document.getElementById('print-slit-report');
    if (!container) {
      container = document.createElement('div');
      container.id = 'print-slit-report';
      container.style.cssText = 'display:none;';
      document.body.appendChild(container);
    }
    container.innerHTML = '';
    container.appendChild(clone);

    const restoreBtn = () => {
      document.title = origTitle;
      if (btn) { btn.disabled = false; btn.textContent = '🖨️ 인쇄'; }
    };

    document.body.classList.add('printing-slit-report');

    // 브라우저가 DOM 변경사항을 렌더링한 뒤 인쇄 대화상자 열기
    setTimeout(() => {
      window.print();

      const cleanup = () => {
        document.body.classList.remove('printing-slit-report');
        container.innerHTML = '';
        window.removeEventListener('afterprint', cleanup);
        restoreBtn();
      };
      window.addEventListener('afterprint', cleanup);
      // afterprint가 발생하지 않는 환경 대비 fallback
      setTimeout(cleanup, 5000);
    }, 150);

  } catch (e) {
    console.error('보고서 인쇄 오류:', e);
    document.title = origTitle;
    document.body.classList.remove('printing-slit-report');
    if (btn) { btn.disabled = false; btn.textContent = '🖨️ 인쇄'; }
    alert('인쇄 준비 오류: ' + e.message);
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
async function _applyEdits() {
  const img = edSt.originalImg;
  if (!img) { _closeEditor(); return; }

  const okBtn = $('btn-editor-ok');
  if (okBtn) { okBtn.disabled = true; okBtn.textContent = '⏳ 처리 중...'; }

  try {
    const W = img.naturalWidth, H = img.naturalHeight;
    const angle = edSt.angle, b = edSt.brightness, c = edSt.contrast;
    const crop = edSt.cropFrac;

    const oc1 = new OffscreenCanvas(W, H);
    const c1  = oc1.getContext('2d');
    c1.translate(W / 2, H / 2);
    c1.rotate(angle * Math.PI / 180);
    c1.drawImage(img, -W / 2, -H / 2);

    const srcX = crop ? Math.round(crop.x0 * W) : 0;
    const srcY = crop ? Math.round(crop.y0 * H) : 0;
    const srcW = crop ? Math.max(1, Math.round((crop.x1 - crop.x0) * W)) : W;
    const srcH = crop ? Math.max(1, Math.round((crop.y1 - crop.y0) * H)) : H;

    const oc2 = new OffscreenCanvas(srcW, srcH);
    const c2  = oc2.getContext('2d');
    c2.drawImage(oc1, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

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

    const blob = await oc2.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
    const url  = URL.createObjectURL(blob);

    await new Promise((resolve, reject) => {
      const newImg = new Image();
      newImg.onload = () => {
        const s = slitStates[editorKey];
        s.imgEl = newImg;
        s.editParams = { angle, brightness: b, contrast: c, cropFrac: crop ? { ...crop } : null };
        _resetAnalysis(s);

        const prev = $(`slit-preview-${editorKey}`);
        if (prev) { prev.src = url; prev.classList.remove('hidden'); }

        if (!$('screen-slit-analyze').classList.contains('hidden') && activeKey === editorKey) {
          _switchSlit(editorKey);
        }
        resolve();
      };
      newImg.onerror = () => reject(new Error('편집된 이미지 로드 실패'));
      newImg.src = url;
    });

    _closeEditor();
  } catch (e) {
    console.error('편집 적용 실패:', e);
    alert('편집 적용 실패: ' + (e?.message || String(e)) + '\n\n이미지를 다시 불러온 후 시도해 주세요.');
  } finally {
    if (okBtn) { okBtn.disabled = false; okBtn.textContent = '✓ 적용'; }
  }
}
