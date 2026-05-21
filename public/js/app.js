// app.js — 메인 컨트롤러

// ── 서비스 워커 등록 (PWA 홈 화면 설치) ──────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

let _installPrompt = null;
const _isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const _isStandalone = window.navigator.standalone === true ||
                      window.matchMedia('(display-mode: standalone)').matches;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _installPrompt = e;
  document.getElementById('btn-install')?.classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  document.getElementById('btn-install')?.classList.add('hidden');
  _installPrompt = null;
});

// iOS: beforeinstallprompt 없이 버튼 표시
if (_isIOS && !_isStandalone) {
  document.getElementById('btn-install')?.classList.remove('hidden');
}

import { initAuth, login, logout } from './auth.js';
import { ZoomController } from './zoomController.js';
import { initFreeMotion }     from './freeMotion.js';
import { VideoController }    from './video.js';
import { Calibration }        from './calibration.js';
import { Tracker }            from './tracker.js';
import { AutoTracker }        from './autotracker.js';
import { GraphRenderer }                        from './graphs.js';
import { generateReport }                        from './report.js';
import { saveReportToCloud, loadAllReportsMeta, deleteClassicReport } from './saveReport.js';
import { pickVideoFromDrive } from './drivePicker.js';


const $ = id => document.getElementById(id);

const screens = {
  login:         $('screen-login'),
  mode:          $('screen-mode'),
  upload:        $('screen-upload'),
  track:         $('screen-track'),
  result:        $('screen-result'),
  'free-upload': $('screen-free-upload'),
  'free-track':  $('screen-free-track'),
  'free-result': $('screen-free-result'),
};

let currentUser = null;
// 'calibration' | 'tracking' | 'auto-box' | 'pan' | null(점 선택/삭제)
let activeMode  = 'pan';
let activeVideo = 'ff';

const ffVideo    = $('ff-video');
const ffCanvas   = $('ff-canvas');
const projVideo  = $('proj-video');
const projCanvas = $('proj-canvas');

const ffCalibration   = new Calibration();
const projCalibration = new Calibration();
const ffTracker       = new Tracker(ffCalibration);
const projTracker     = new Tracker(projCalibration);
const ffAutoTracker   = new AutoTracker();
const projAutoTracker = new AutoTracker();
const graphs          = new GraphRenderer();

const ffController   = new VideoController(ffVideo,   ffCanvas,   (fps, auto) => onFpsDetected('ff',   fps, auto));
const projController = new VideoController(projVideo, projCanvas, (fps, auto) => onFpsDetected('proj', fps, auto));

let dragState        = null;  // 박스 선택 드래그
let dragPoint        = null;  // 포인트 이동 드래그 { index }
let potentialDrag    = null;  // 탭 vs 드래그 구분 { index, startX, startY }
let selectedPointIdx = -1;    // 선택된 점 인덱스 (-1이면 없음)
let canResumeAuto    = false; // 자동 추적 재개 가능 여부
let calibDragIdx     = -1;    // 보정 점 드래그 인덱스
let panStart         = null;  // 패닝 시작 좌표 { clientX, clientY }

// ── 인증 ─────────────────────────────────────────────
initAuth(
  async user => {
    currentUser = user;
    $('user-name').textContent = user.email;
    $('btn-logout').classList.remove('hidden');
    showScreen('mode');
  },
  () => {
    currentUser = null;
    $('user-name').textContent = '';
    $('btn-logout').classList.add('hidden');
    showScreen('login');
  }
);

$('btn-login').addEventListener('click', login);
$('btn-logout').addEventListener('click', logout);

$('btn-install')?.addEventListener('click', async () => {
  if (_installPrompt) {
    _installPrompt.prompt();
    const { outcome } = await _installPrompt.userChoice;
    if (outcome === 'accepted') $('btn-install').classList.add('hidden');
    _installPrompt = null;
  } else if (_isIOS && !_isStandalone) {
    $('ios-install-modal').classList.remove('hidden');
  }
});

$('ios-install-close')?.addEventListener('click', () => $('ios-install-modal').classList.add('hidden'));
$('ios-install-modal')?.addEventListener('click', e => {
  if (e.target === e.currentTarget) $('ios-install-modal').classList.add('hidden');
});

$('btn-about').addEventListener('click', () => $('about-modal').classList.remove('hidden'));
$('about-close').addEventListener('click', () => $('about-modal').classList.add('hidden'));
$('about-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) $('about-modal').classList.add('hidden');
});

// 모드 선택
$('btn-card-classic').addEventListener('click', () => { showScreen('upload'); checkPrevReport(); });
$('btn-card-free').addEventListener('click',    () => showScreen('free-upload'));
$('btn-back-mode').addEventListener('click',    () => showScreen('mode'));

// freeMotion 모듈 초기화
initFreeMotion(showScreen);

function showScreen(name) {
  Object.values(screens).forEach(s => s?.classList.add('hidden'));
  screens[name]?.classList.remove('hidden');
  // 로그인·트래킹 화면에서는 푸터 숨김, 나머지는 표시
  const hideFooter = ['login', 'track', 'free-track'].includes(name);
  $('app-footer')?.classList.toggle('hidden', hideFooter);
}

// ── 영상 업로드 ───────────────────────────────────────
async function pickFromDrive(type) {
  const btn   = $(`${type}-drive-btn`);
  const label = $(`${type}-filename`);
  btn.disabled = true;
  btn.textContent = '불러오는 중...';
  try {
    const { blob, name } = await pickVideoFromDrive();
    label.textContent = `✓ ${name}`;
    await loadVideo(blob, type);
  } catch (e) {
    if (e.message !== '취소됨') alert('영상을 불러올 수 없습니다.\n' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '📂 드라이브에서 선택';
  }
}

$('ff-drive-btn').addEventListener('click',   () => pickFromDrive('ff'));
$('proj-drive-btn').addEventListener('click', () => pickFromDrive('proj'));

$('ff-local-btn').addEventListener('click',   () => $('ff-file-input').click());
$('proj-local-btn').addEventListener('click', () => $('proj-file-input').click());

$('ff-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  $('ff-filename').textContent = `✓ ${file.name}`;
  loadVideo(file, 'ff');
  e.target.value = '';
});
$('proj-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  $('proj-filename').textContent = `✓ ${file.name}`;
  loadVideo(file, 'proj');
  e.target.value = '';
});

async function loadVideo(file, type) {
  if (!file) return;
  $(`${type}-fps-status`).textContent = 'fps 측정 중...';
  await (type === 'ff' ? ffController : projController).load(file);
  // 새 영상 로드 시 줌 초기화
  if (type === 'ff')   ffZoom?.reset();
  else                 projZoom?.reset();
  updateFrameSlider(type);
  fitCanvases();
  checkUploadReady();
}

function onFpsDetected(type, fps, auto) {
  $(`${type}-capture-fps`).value = fps;
  $(`${type}-fps-status`).textContent = auto ? `자동 감지: ${fps}fps` : `기본값: ${fps}fps`;
}

$('ff-capture-fps').addEventListener('change', e => {
  const fps = Math.max(1, parseInt(e.target.value) || 1);
  e.target.value = fps;
  ffController.setFps(fps);
  updateFrameSlider('ff');
  if (activeVideo === 'ff') updateTrackCaptureFps();
});
$('proj-capture-fps').addEventListener('change', e => {
  const fps = Math.max(1, parseInt(e.target.value) || 1);
  e.target.value = fps;
  projController.setFps(fps);
  updateFrameSlider('proj');
  if (activeVideo === 'proj') updateTrackCaptureFps();
});

function checkUploadReady() {
  $('btn-to-track').disabled = !(ffVideo.readyState >= 1 && projVideo.readyState >= 1);
}

$('btn-to-track').addEventListener('click', () => {
  showScreen('track');
  requestAnimationFrame(() => {
    requestAnimationFrame(fitCanvases);
    updateTrackCaptureFps();
  });
});

// ← 영상 변경으로 돌아가기
$('btn-back-upload').addEventListener('click', () => {
  if (activeTracker().points.length > 0) {
    if (!confirm('트래킹 데이터가 있습니다. 영상 선택 화면으로 돌아갈까요?')) return;
  }
  showScreen('upload');
});

// ── 화면 맞춤 ─────────────────────────────────────────
function fitCanvases() {
  // wrapper는 두 캔버스가 공유 — 하나만 보이는 상태여도 wrapper 크기는 동일
  const wrapper = document.querySelector('.canvas-wrapper');
  if (!wrapper) return;
  const ww = wrapper.clientWidth;
  const wh = wrapper.clientHeight;
  if (!ww || !wh) return; // 숨겨진 화면이면 0 → 건너뜀

  [ffCanvas, projCanvas].forEach(canvas => {
    if (!canvas.width || !canvas.height) return;
    const scale = Math.min(ww / canvas.width, wh / canvas.height);
    canvas.style.width  = Math.round(canvas.width  * scale) + 'px';
    canvas.style.height = Math.round(canvas.height * scale) + 'px';
  });
}

// 창 크기 변경 시 재조정
window.addEventListener('resize', fitCanvases);

// canvas-wrapper 크기 변경 감지 (패널 열림/닫힘 등)
if (window.ResizeObserver) {
  new ResizeObserver(fitCanvases)
    .observe(document.querySelector('.canvas-wrapper'));
}

// ── 트래킹 화면 헬퍼 ──────────────────────────────────
const activeController  = () => activeVideo === 'ff' ? ffController    : projController;
const activeCanvas      = () => activeVideo === 'ff' ? ffCanvas         : projCanvas;
const activeTracker     = () => activeVideo === 'ff' ? ffTracker        : projTracker;
const activeAutoTracker = () => activeVideo === 'ff' ? ffAutoTracker    : projAutoTracker;
const activeCalibration = () => activeVideo === 'ff' ? ffCalibration    : projCalibration;

// 시간 보정: tSec = 프레임번호 / 촬영fps
function computeTSec(ctrl, type) {
  const captureFps = Math.max(1, parseInt($(`${type}-capture-fps`).value) || ctrl.fps);
  return ctrl.currentFrame / captureFps;
}

// 영상 탭 전환
$('tab-ff').addEventListener('click',   () => switchVideo('ff'));
$('tab-proj').addEventListener('click', () => switchVideo('proj'));

function switchVideo(type) {
  calibDragIdx = -1;
  hideCalibBar();
  activeVideo = type;
  $('tab-ff').classList.toggle('active',   type === 'ff');
  $('tab-proj').classList.toggle('active', type === 'proj');
  ffCanvas.classList.toggle('hidden-canvas',   type !== 'ff');
  projCanvas.classList.toggle('hidden-canvas', type !== 'proj');
  $('frame-slider').max   = Math.max(0, activeController().totalFrames - 1);
  $('frame-slider').value = activeController().currentFrame;
  requestAnimationFrame(fitCanvases);
  redraw();
  updateFrameInfo();
  updateCalibStatus();
  updateTrackCaptureFps();
}

function showCalibBar() {
  const calib = activeCalibration();
  if (calib.points.length < 2) return;
  $('calib-px-dist').textContent = `픽셀 거리: ${calib.pixelDistance?.toFixed(1) ?? '-'}px`;
  $('calib-real-cm').value = calib.realLengthCm ?? '';
  $('calib-input-bar').classList.remove('hidden');
  $('calib-real-cm').focus();
}

function hideCalibBar() {
  $('calib-input-bar').classList.add('hidden');
}

function updateCalibBarDist() {
  if ($('calib-input-bar').classList.contains('hidden')) return;
  const calib = activeCalibration();
  $('calib-px-dist').textContent = `픽셀 거리: ${calib.pixelDistance?.toFixed(1) ?? '-'}px`;
}

// ── 프레임 탐색 ───────────────────────────────────────
$('btn-prev').addEventListener('click', () => stepFrame(-1));
$('btn-next').addEventListener('click', () => stepFrame(1));
$('frame-slider').addEventListener('input', async e => {
  await activeController().seekToFrame(Number(e.target.value));
  redraw();
  updateFrameInfo();
});

$('track-capture-fps').addEventListener('change', e => {
  const newFps = Math.max(1, parseInt(e.target.value) || 1);
  e.target.value = newFps;
  $(`${activeVideo}-capture-fps`).value = newFps;
  activeController().setFps(newFps);
  activeTracker().recomputeTimes(newFps);
  updateFrameSlider(activeVideo);
  updateTrackInterval();
});

// ← → 방향키 프레임 이동
document.addEventListener('keydown', e => {
  if (!screens.track || screens.track.classList.contains('hidden')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft')  { e.preventDefault(); stepFrame(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); stepFrame(1);  }
});

async function stepFrame(delta) {
  const ctrl = activeController();
  const next = Math.max(0, Math.min(ctrl.currentFrame + delta, ctrl.totalFrames - 1));
  await ctrl.seekToFrame(next);
  $('frame-slider').value = ctrl.currentFrame;
  redraw();
  updateFrameInfo();
}

function updateFrameInfo() {
  const ctrl = activeController();
  $('frame-info').textContent =
    `프레임 ${ctrl.currentFrame} / ${ctrl.totalFrames - 1}  (${ctrl.video.currentTime.toFixed(3)}s)`;
  updateTrackInterval();
}

function updateTrackCaptureFps() {
  const val = $(`${activeVideo}-capture-fps`)?.value || '30';
  $('track-capture-fps').value = val;
  updateTrackInterval();
}

function updateTrackInterval() {
  const cap = Math.max(1, parseInt($('track-capture-fps')?.value) || 30);
  const el = $('track-interval');
  if (el) el.textContent = `1프레임=${(1 / cap).toFixed(4)}s`;
}

function updateFrameSlider(type) {
  if (activeVideo !== type) return;
  $('frame-slider').max   = Math.max(0, activeController().totalFrames - 1);
  $('frame-slider').value = 0;
  updateFrameInfo();
}

// ── 모드 전환 ─────────────────────────────────────────
$('btn-mode-calib').addEventListener('click', () => setMode('calibration'));
$('btn-mode-track').addEventListener('click', () => setMode('tracking'));
$('btn-mode-auto').addEventListener('click', () => {
  activeAutoTracker().reset();
  dragState = null;
  canResumeAuto = false;
  $('btn-start-auto').disabled = true;
  $('btn-resume-auto').classList.add('hidden');
  $('auto-seed-status').textContent = '추적할 물체를 박스로 드래그하여 선택하세요';
  $('auto-progress-wrap').classList.add('hidden');
  $('auto-conf-bar-wrap').classList.add('hidden');
  $('auto-progress-bar').style.width = '0%';
  setMode('auto-box');
});
$('btn-mode-none').addEventListener('click', () => setMode(null));
$('btn-mode-pan').addEventListener('click',  () => setMode('pan'));

$('btn-calib-confirm').addEventListener('click', () => {
  const cm = parseFloat($('calib-real-cm').value);
  if (!cm || cm <= 0) { $('calib-real-cm').focus(); return; }
  const calib = activeCalibration();
  if (calib.points.length < 2) return;
  calib.setRealLength(cm);
  activeTracker().recomputeUnits();
  updateCalibStatus();
  hideCalibBar();
  setMode('pan');
  redraw();
});

$('btn-calib-reset-pts').addEventListener('click', () => {
  activeCalibration().reset();
  calibDragIdx = -1;
  hideCalibBar();
  redraw();
});

$('btn-undo').addEventListener('click', () => {
  if (activeMode === 'calibration') {
    activeCalibration().points.pop();
    if (activeCalibration().points.length < 2) hideCalibBar();
  } else if (selectedPointIdx !== -1) {
    activeTracker().removeAt(selectedPointIdx);
    selectedPointIdx = -1;
  } else {
    activeTracker().removeLast();
  }
  redraw();
});

$('btn-reset').addEventListener('click', () => {
  if (!confirm('현재 영상의 모든 추적 포인트를 초기화할까요?')) return;
  activeTracker().reset();
  activeAutoTracker().reset();
  dragState = null; dragPoint = null;
  setMode('pan');
  redraw();
});

function setMode(mode) {
  if (mode !== 'calibration') {
    calibDragIdx = -1;
    hideCalibBar();
  }
  if (mode !== 'pan') panStart = null;
  activeMode = mode;
  selectedPointIdx = -1;
  const modeMap = { calibration: 'calib', tracking: 'track', 'auto-box': 'auto', pan: 'pan' };
  ['calib','track','auto','none','pan'].forEach(m => {
    $(`btn-mode-${m}`)?.classList.toggle('active', mode ? modeMap[mode] === m : m === 'none');
  });

  const isCross = ['tracking','calibration','auto-box'].includes(mode);
  [ffCanvas, projCanvas].forEach(c => { c.style.cursor = isCross ? 'crosshair' : 'grab'; });

  $('auto-panel').classList.toggle('hidden', mode !== 'auto-box');

  updateCalibStatus();
  $('mode-hint').textContent =
    mode === 'calibration' ? '자(ruler)의 양 끝점 두 곳을 클릭하세요' :
    mode === 'tracking'    ? '물체 중심을 클릭하세요 (← → 키로 프레임 이동)' :
    mode === 'auto-box'    ? '추적할 물체를 박스로 드래그하세요' :
    mode === 'pan'         ? '드래그로 화면을 이동하세요 (확대된 상태에서만 동작)' :
    mode === null          ? '점 탭→선택(✕), 재탭→삭제 / 드래그→이동' : '';
}

function updateCalibStatus() {
  const el   = $('calib-status');
  const calib = activeCalibration();
  if (calib.isCalibrated) {
    el.textContent = `보정 완료: ${calib.scale?.toFixed(4)} cm/px`;
    el.style.color = '#66bb6a';
  } else {
    el.textContent = '보정 없음 (px 단위)';
    el.style.color = '#ffa726';
  }
}

// ── 캔버스 포인터 이벤트 ──────────────────────────────
[ffCanvas, projCanvas].forEach(canvas => {
  canvas.addEventListener('mousedown',  onPointerDown);
  canvas.addEventListener('mousemove',  onPointerMove);
  canvas.addEventListener('mouseup',    onPointerUp);
  canvas.addEventListener('mouseleave', () => {
    potentialDrag = null;
    if (panStart) { panStart = null; activeCanvas().style.cursor = 'grab'; }
    if (dragPoint) { dragPoint = null; activeCanvas().style.cursor = 'grab'; }
  });
  // 터치 이벤트는 ZoomController가 처리 (아래에서 생성)
});

// ZoomController: 핀치줌(두 손가락) + 마우스 휠 / 한 손가락은 기존 핸들러로 위임
const _zoomUpdate = scale => {
  const btn  = $('btn-zoom-reset');
  const span = $('zoom-indicator');
  if (!btn) return;
  if (scale <= 1) { btn.classList.add('hidden'); }
  else { span.textContent = `${scale.toFixed(1)}×`; btn.classList.remove('hidden'); }
};
const ffZoom   = new ZoomController(ffCanvas,   { onDown: onPointerDown, onMove: onPointerMove, onUp: onPointerUp, onZoom: _zoomUpdate });
const projZoom = new ZoomController(projCanvas, { onDown: onPointerDown, onMove: onPointerMove, onUp: onPointerUp, onZoom: _zoomUpdate });
const activeZoom = () => activeVideo === 'ff' ? ffZoom : projZoom;

$('btn-zoom-reset').addEventListener('click', () => {
  ffZoom.reset(); projZoom.reset();
});

function canvasPoint(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (canvas.width  / rect.width),
    y: (clientY - rect.top)  * (canvas.height / rect.height),
  };
}

function isActiveCanvas(c) {
  return (activeVideo === 'ff' && c === ffCanvas) || (activeVideo === 'proj' && c === projCanvas);
}

function onPointerDown(e) {
  if (!isActiveCanvas(e.currentTarget)) return;
  const { x, y } = canvasPoint(e.currentTarget, e.clientX, e.clientY);

  if (activeMode === 'pan') {
    panStart = { clientX: e.clientX, clientY: e.clientY };
    activeCanvas().style.cursor = 'grabbing';
    return;
  }

  if (activeMode === null) {
    // 이동 모드: 탭 → 선택/해제, 드래그 → 이동
    const idx = activeTracker().findPointNear(x, y);
    if (idx !== -1) {
      potentialDrag = { index: idx, startX: x, startY: y };
    } else {
      // 빈 곳 탭 → 선택 해제
      selectedPointIdx = -1;
      redraw();
    }

  } else if (activeMode === 'auto-box') {
    dragState = { startX: x, startY: y, endX: x, endY: y, active: true };

  } else if (activeMode === 'calibration') {
    const calib = activeCalibration();
    if (calib.isOnButton(x, y)) {
      showCalibBar();
      return;
    }
    const nearIdx = calib.findPointNear(x, y);
    if (nearIdx !== -1) {
      calibDragIdx = nearIdx;
    } else if (calib.points.length < 2) {
      calib.addPoint(x, y);
    }
    redraw();

  } else if (activeMode === 'tracking') {
    const ctrl = activeController();
    const tSec = computeTSec(ctrl, activeVideo);
    activeTracker().addPoint(x, y, ctrl.currentFrame, tSec);
    redraw();
  }
}

function onPointerMove(e) {
  if (!isActiveCanvas(e.currentTarget)) return;
  const { x, y } = canvasPoint(e.currentTarget, e.clientX, e.clientY);

  if (panStart && activeMode === 'pan') {
    if (!isActiveCanvas(e.currentTarget)) return;
    const dx = e.clientX - panStart.clientX;
    const dy = e.clientY - panStart.clientY;
    activeZoom().pan(dx, dy);
    panStart = { clientX: e.clientX, clientY: e.clientY };
    return;
  }

  if (calibDragIdx !== -1 && activeMode === 'calibration') {
    const calib = activeCalibration();
    calib.movePoint(calibDragIdx, x, y);
    updateCalibBarDist();
    if (calib.realLengthCm) {
      calib.setRealLength(calib.realLengthCm);
      activeTracker().recomputeUnits();
      updateCalibStatus();
    }
    redraw(); return;
  }

  // potentialDrag → 5px 이상 이동하면 실제 드래그로 전환
  if (potentialDrag) {
    const dx = x - potentialDrag.startX, dy = y - potentialDrag.startY;
    if (Math.sqrt(dx * dx + dy * dy) > 5) {
      dragPoint = { index: potentialDrag.index };
      potentialDrag = null;
      activeCanvas().style.cursor = 'grabbing';
    }
  }

  if (dragPoint) {
    activeTracker().updatePoint(dragPoint.index, x, y);
    redraw(); return;
  }
  if (dragState?.active) {
    dragState.endX = x; dragState.endY = y;
    redraw(); drawSelectionBox(activeCanvas());
  }
}

function onPointerUp(e) {
  if (panStart) {
    panStart = null;
    activeCanvas().style.cursor = 'grab';
    return;
  }
  if (calibDragIdx !== -1) {
    calibDragIdx = -1;
    return;
  }
  if (potentialDrag) {
    if (selectedPointIdx === potentialDrag.index) {
      // 이미 선택된 점을 재탭 → 삭제
      activeTracker().removeAt(potentialDrag.index);
      selectedPointIdx = -1;
    } else {
      // 새 점 탭 → 선택 (✕ 표시) + 해당 프레임으로 영상 이동
      selectedPointIdx = potentialDrag.index;
      const pt = activeTracker().points[selectedPointIdx];
      if (pt !== undefined) {
        activeController().seekToFrame(pt.frame).then(() => {
          $('frame-slider').value = activeController().currentFrame;
          updateFrameInfo();
          redraw();
        });
      }
    }
    potentialDrag = null;
    redraw(); return;
  }
  if (dragPoint) {
    dragPoint = null;
    activeCanvas().style.cursor = 'grab'; return;
  }
  if (!dragState?.active) return;
  if (e.type === 'mouseleave') { dragState.active = false; return; }

  const { x, y } = canvasPoint(e.currentTarget, e.clientX, e.clientY);
  dragState.active = false;
  dragState.endX = x; dragState.endY = y;

  const bx = Math.min(dragState.startX, dragState.endX);
  const by = Math.min(dragState.startY, dragState.endY);
  const bw = Math.abs(dragState.endX - dragState.startX);
  const bh = Math.abs(dragState.endY - dragState.startY);

  if (bw < 10 || bh < 10) {
    $('auto-seed-status').textContent = '박스가 너무 작습니다. 다시 드래그하세요.';
    dragState = null; return;
  }

  activeAutoTracker().seedFromBox(activeCanvas(), bx, by, bw, bh);
  $('auto-seed-status').textContent =
    `선택 완료 (${Math.round(bw)}×${Math.round(bh)}px) — 추적 시작을 누르세요`;
  $('btn-start-auto').disabled = false;
  redraw(); drawSelectionBox(activeCanvas());
}

function drawSelectionBox(canvas) {
  if (!dragState) return;
  const ctx = canvas.getContext('2d');
  const x = Math.min(dragState.startX, dragState.endX);
  const y = Math.min(dragState.startY, dragState.endY);
  const w = Math.abs(dragState.endX - dragState.startX);
  const h = Math.abs(dragState.endY - dragState.startY);
  const color = dragState.lowConf ? '#ffa726' : '#00e5ff';

  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.setLineDash(dragState.active ? [6, 3] : []);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([px,py]) => ctx.fillRect(px-4, py-4, 8, 8));
  ctx.beginPath(); ctx.arc(x+w/2, y+h/2, 4, 0, Math.PI*2);
  ctx.fillStyle = dragState.lowConf ? '#ffa726' : '#ff5722'; ctx.fill();
  ctx.restore();
}

// ── 자동 추적 실행 ────────────────────────────────────
$('btn-start-auto').addEventListener('click',  () => runAutoTracking(false));
$('btn-resume-auto').addEventListener('click', () => runAutoTracking(true));

async function runAutoTracking(resume = false) {
  const at = activeAutoTracker(), ctrl = activeController(), tracker = activeTracker();
  if (!at.seeded) { alert('먼저 물체를 선택하세요.'); return; }

  const interval  = Math.max(1, parseInt($('auto-interval').value)  || 1);
  const maxPoints = Math.max(1, parseInt($('auto-maxframes').value) || 20);

  let startFrame;
  if (resume) {
    const lastPt = tracker.points[tracker.points.length - 1];
    if (!lastPt) { alert('재개할 추적 데이터가 없습니다.'); return; }
    // 마지막 유효 프레임으로 이동 후 (드래그로 보정된) 위치로 템플릿 재구성
    await ctrl.seekToFrame(lastPt.frame);
    redraw();
    at.resumeFrom(activeCanvas(), lastPt.xPx, lastPt.yPx);
    startFrame = lastPt.frame + interval;
  } else {
    startFrame = ctrl.currentFrame;
    tracker.reset();
  }

  const endFrame = Math.min(startFrame + interval * maxPoints, ctrl.totalFrames - 1);

  $('btn-resume-auto').classList.add('hidden');
  canResumeAuto = false;
  $('btn-start-auto').disabled = true;
  $('btn-stop-auto').disabled  = false;
  $('auto-progress-wrap').classList.remove('hidden');
  $('auto-conf-bar-wrap').classList.remove('hidden');

  let stopped = false, count = 0;
  $('btn-stop-auto').onclick = () => { stopped = true; };

  const total = Math.ceil((endFrame - startFrame) / interval) + 1;

  for (let f = startFrame; f <= endFrame; f += interval) {
    if (stopped) break;

    await ctrl.seekToFrame(f);
    $('frame-slider').value = ctrl.currentFrame;

    const result = at.findInCanvas(activeCanvas(), interval);
    const { x, y, confidence, lowConfidence, outOfBounds } = result;

    // 화면 밖 이탈 → 즉시 중단 (재개 가능 상태로 표시)
    if (outOfBounds) {
      $('auto-seed-status').textContent = '⚠️ 물체가 화면 밖으로 벗어남 — 추적 중단';
      canResumeAuto = true;
      break;
    }
    // 저신뢰도 → 경고만 표시하고 계속 진행
    if (lowConfidence) {
      $('auto-seed-status').textContent = '⚠️ 신뢰도 낮음 — 계속 추적 중';
    }

    at.updateVelocity(x, y);
    at.lastPos = { x, y };
    at.updateTemplate(activeCanvas(), x, y, confidence);
    tracker.addPoint(x, y, f, computeTSec(ctrl, activeVideo), false);
    redraw();

    dragState = { startX: x - at.thW, startY: y - at.thH,
                  endX:   x + at.thW, endY:   y + at.thH, active: false, lowConf: false };
    drawSelectionBox(activeCanvas());

    const pct = Math.round(confidence * 100);
    $('auto-conf-bar').style.width      = pct + '%';
    $('auto-conf-bar').style.background =
      confidence > 0.7 ? '#66bb6a' : confidence > 0.5 ? '#ffa726' : '#ef5350';
    $('auto-conf-label').textContent    = `신뢰도 ${pct}%`;

    count++;
    $('auto-progress-bar').style.width   = Math.round((count / total) * 100) + '%';
    $('auto-progress-label').textContent = `${count} / ${total}`;
    updateFrameInfo();

    await new Promise(r => setTimeout(r, 500));
  }

  $('btn-start-auto').disabled = false;
  $('btn-stop-auto').disabled  = true;

  if (canResumeAuto && !stopped) {
    // 재개 버튼 표시 + 패널 유지 + 이동 모드(포인트 드래그 가능)
    $('btn-resume-auto').classList.remove('hidden');
    $('auto-seed-status').textContent += ' — 마지막 점 드래그로 보정 후 이어서 추적 가능';
    setMode(null);
    $('auto-panel').classList.remove('hidden');
  } else {
    if (!$('auto-seed-status').textContent.startsWith('⚠️')) {
      $('auto-seed-status').textContent = `완료 — ${count}개 점 기록됨`;
    }
    setMode('pan');
  }
}

// ── 캔버스 재렌더링 ───────────────────────────────────
function redraw() {
  const ctrl = activeController(), canvas = activeCanvas();
  const ctx  = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctrl.drawCurrentFrame();
  activeCalibration().draw(ctx);
  activeTracker().draw(ctx, activeVideo, selectedPointIdx, $('color-h').value, $('color-v').value);
}

// ── 결과 화면 ─────────────────────────────────────────
$('color-h').addEventListener('input', redraw);
$('color-v').addEventListener('input', redraw);

$('btn-to-result').addEventListener('click', () => { showScreen('result'); renderAllGraphs(); });

// 수평투사 x: 촬영 방향(좌→우, 우→좌)에 관계없이 항상 양수로 표시
function _absX(data) {
  return data.map(d => ({ ...d, relXCm: d.relXCm != null ? Math.abs(d.relXCm) : null }));
}

function renderAllGraphs() {
  const ffUnit   = ffCalibration.unit;
  const projUnit = projCalibration.unit;
  const ffRel   = ffTracker.getRelativeData();
  const projRel = _absX(projTracker.getRelativeData());
  if (ffRel.length > 0)   graphs.renderFreeFall($('chart-ff'), ffRel, ffUnit);
  if (projRel.length > 0) graphs.renderProjectileX($('chart-proj-x'), projRel, projUnit);
  if (ffRel.length > 0 && projRel.length > 0)
    graphs.renderProjectileY($('chart-proj-y'), ffRel, projRel, ffUnit);
  _renderDataTable(ffRel, projRel, ffUnit, projUnit);
}

// 데이터 행 공통 계산
function _tableRows(ffData, projData) {
  const n = Math.max(ffData.length, projData.length);
  return Array.from({ length: n }, (_, i) => {
    const ff = ffData[i], pr = projData[i];
    const pF = ffData[i - 1], pP = projData[i - 1];
    return {
      t:    ff?.relTSec ?? pr?.relTSec,
      ffY:  ff?.relYCm  ?? null,
      ffDy: (ff?.relYCm != null && pF?.relYCm != null) ? ff.relYCm - pF.relYCm : null,
      prY:  pr?.relYCm  ?? null,
      prDy: (pr?.relYCm != null && pP?.relYCm != null) ? pr.relYCm - pP.relYCm : null,
      prX:  pr?.relXCm  ?? null,
      prDx: (pr?.relXCm != null && pP?.relXCm != null) ? pr.relXCm - pP.relXCm : null,
    };
  });
}

function _renderDataTable(ffData, projData, ffUnit, projUnit) {
  const wrap = $('data-table-wrap');
  if (!wrap) return;
  const rows = _tableRows(ffData, projData);
  if (!rows.length) { wrap.innerHTML = '<p style="color:var(--text-dim);font-size:14px;">데이터 없음</p>'; return; }

  const fmt = (v, d = 2) => v != null ? v.toFixed(d) : '-';

  let html = `<table class="data-table"><thead><tr>
    <th>시간(s)</th>
    <th>자유낙하 y (${ffUnit})</th><th>Δy (${ffUnit})</th>
    <th>수평투사 y (${projUnit})</th><th>Δy (${projUnit})</th>
    <th>수평투사 x (${projUnit})</th><th>Δx (${projUnit})</th>
  </tr></thead><tbody>`;

  rows.forEach(r => {
    html += `<tr>
      <td>${typeof r.t === 'number' ? r.t.toFixed(3) : ''}</td>
      <td>${fmt(r.ffY)}</td><td>${fmt(r.ffDy)}</td>
      <td>${fmt(r.prY)}</td><td>${fmt(r.prDy)}</td>
      <td>${fmt(r.prX)}</td><td>${fmt(r.prDx)}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

$('btn-copy-table').addEventListener('click', () => {
  const ffRel   = ffTracker.getRelativeData();
  const projRel = _absX(projTracker.getRelativeData());
  const ffUnit   = ffCalibration.unit;
  const projUnit = projCalibration.unit;
  const rows = _tableRows(ffRel, projRel);
  if (!rows.length) return;

  const fmt = (v, d = 2) => v != null ? v.toFixed(d) : '';
  const header = ['시간(s)',
    `자유낙하 y (${ffUnit})`, `Δy (${ffUnit})`,
    `수평투사 y (${projUnit})`, `Δy (${projUnit})`,
    `수평투사 x (${projUnit})`, `Δx (${projUnit})`,
  ].join('\t');
  const lines = rows.map(r => [
    typeof r.t === 'number' ? r.t.toFixed(3) : '',
    fmt(r.ffY), fmt(r.ffDy),
    fmt(r.prY), fmt(r.prDy),
    fmt(r.prX), fmt(r.prDx),
  ].join('\t'));

  const tsv = [header, ...lines].join('\n');
  const statusEl = $('copy-status');

  const showOk = () => {
    statusEl.textContent = '✅ 복사됨 — Google Sheets에 붙여넣기 하세요';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  };

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(tsv).then(showOk).catch(() => _fallbackCopy(tsv, showOk));
  } else {
    _fallbackCopy(tsv, showOk);
  }
});

function _fallbackCopy(text, onDone) {
  const ta = document.createElement('textarea');
  ta.value = text;
  Object.assign(ta.style, { position: 'fixed', opacity: '0', top: '0', left: '0' });
  document.body.appendChild(ta);
  ta.focus(); ta.select(); ta.setSelectionRange(0, 99999);
  try { document.execCommand('copy'); onDone(); } catch (e) { alert('복사 실패: 수동으로 복사해 주세요.'); }
  document.body.removeChild(ta);
}

$('btn-report').addEventListener('click', async () => {
  const name = $('student-name').value.trim() || '이름없음';
  const cls  = $('student-class').value.trim() || '00000';
  const ffData   = ffTracker.getRelativeData();
  const projData = _absX(projTracker.getRelativeData());

  $('cloud-save-status').textContent = '☁ 저장 중...';
  $('cloud-save-status').style.color = 'var(--text-dim)';

  try {
    const pngBlob = await generateReport({
      studentName: name, className: cls,
      date: new Date().toLocaleDateString('ko-KR'),
      freeFallCanvas: ffCanvas, projectileCanvas: projCanvas,
      ffData, projData, ffCalibration, projCalibration,
      chartCanvases: { ffChart: $('chart-ff'), projXChart: $('chart-proj-x'), projYChart: $('chart-proj-y') }
    });

    const reportUrl = await saveReportToCloud({ studentName: name, className: cls, ffData, projData, ffCalibration, projCalibration, pngBlob });
    $('cloud-save-status').textContent = `✅ 저장 완료 — 목록에 추가됨 (로그인 후 언제든 다운로드 가능)`;
    $('cloud-save-status').style.color = '#66bb6a';
    checkPrevReport();
  } catch (e) {
    console.error('클라우드 저장 실패:', e);
    $('cloud-save-status').textContent = `⚠ 클라우드 저장 실패 (로컬 다운로드는 완료됨)`;
    $('cloud-save-status').style.color = '#ffa726';
  }
});

// ── 보고서 뷰어 모달 ──────────────────────────────────
const reportModal = $('report-modal');
$('modal-close').addEventListener('click', () => reportModal.classList.add('hidden'));
reportModal.addEventListener('click', e => { if (e.target === reportModal) reportModal.classList.add('hidden'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') reportModal.classList.add('hidden'); });

// freeMotion.js 등 다른 모듈에서도 모달 열기 가능
window._openReportModal = url => {
  $('modal-report-img').src = url;
  reportModal.classList.remove('hidden');
};

// 보고서 목록 클릭 위임 (한 번만 등록)
$('report-list').addEventListener('click', async e => {
  const viewBtn = e.target.closest('.btn-view-report');
  if (viewBtn) { window._openReportModal(viewBtn.dataset.url); return; }

  const delBtn = e.target.closest('.btn-delete-report');
  if (delBtn) {
    if (!confirm('이 보고서를 삭제할까요?')) return;
    const row = delBtn.closest('.report-item');
    delBtn.disabled = true; delBtn.textContent = '…';
    try {
      await deleteClassicReport({ docId: row.dataset.docId, storagePath: row.dataset.storePath });
      row.remove();
      if (!$('report-list').children.length) $('prev-report-card').classList.add('hidden');
    } catch (err) {
      alert('삭제 실패: ' + err.message);
      delBtn.disabled = false; delBtn.textContent = '🗑';
    }
  }
});

// 업로드 화면에 저장된 보고서 목록 표시
async function checkPrevReport() {
  try {
    const list = await loadAllReportsMeta();
    const container = $('report-list');
    container.innerHTML = '';
    if (!list.length) { $('prev-report-card').classList.add('hidden'); return; }

    list.forEach((meta, i) => {
      const dt      = meta.createdAt?.toDate?.();
      const dateStr = dt ? dt.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' }) : '';
      const timeStr = dt ? dt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';

      const row = document.createElement('div');
      row.className = 'report-item';
      row.dataset.docId  = meta.id;
      row.dataset.storePath = meta.storagePath || '';
      row.innerHTML = `
        <div class="report-item-info">
          <span class="report-item-seq">${i + 1}회</span>
          <span class="report-item-name">${meta.studentName || ''} ${meta.className || ''}</span>
          <span class="report-item-date">${dateStr} ${timeStr}</span>
        </div>
        <div class="report-item-actions">
          <button class="btn-view-report" data-url="${meta.reportUrl}">👁 보기</button>
          <a href="${meta.reportUrl}" class="btn-dl" target="_blank" rel="noopener" download>📥 다운로드</a>
          <button class="btn-delete-report btn-reset">🗑</button>
        </div>
      `;
      container.appendChild(row);
    });

    $('prev-report-card').classList.remove('hidden');

  } catch (e) { console.warn('보고서 목록 로드 실패:', e); }
}
