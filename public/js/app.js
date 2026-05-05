// app.js — 메인 컨트롤러

import { initAuth, login, logout } from './auth.js';
import { VideoController } from './video.js';
import { Calibration } from './calibration.js';
import { Tracker } from './tracker.js';
import { GraphRenderer } from './graphs.js';
import { generateReport } from './report.js';

// ── DOM 참조 ────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  login: $('screen-login'),
  upload: $('screen-upload'),
  track: $('screen-track'),
  result: $('screen-result'),
};

let currentUser = null;
let activeMode = null;       // 'calibration' | 'tracking'
let activeVideo = 'ff';      // 'ff' | 'proj'

const ffVideo    = $('ff-video');
const ffCanvas   = $('ff-canvas');
const projVideo  = $('proj-video');
const projCanvas = $('proj-canvas');

const calibration = new Calibration();
const ffTracker   = new Tracker(calibration);
const projTracker = new Tracker(calibration);
const graphs      = new GraphRenderer();

const ffController   = new VideoController(ffVideo, ffCanvas, (fps, auto) => onFpsDetected('ff', fps, auto));
const projController = new VideoController(projVideo, projCanvas, (fps, auto) => onFpsDetected('proj', fps, auto));

// ── 인증 ─────────────────────────────────────────────
initAuth(
  user => {
    currentUser = user;
    $('user-name').textContent = user.displayName;
    $('btn-logout').classList.remove('hidden');
    showScreen('upload');
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

// ── 화면 전환 ─────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name]?.classList.remove('hidden');
}

// ── 영상 업로드 ───────────────────────────────────────
$('ff-file').addEventListener('change', e => loadVideo(e.target.files[0], 'ff'));
$('proj-file').addEventListener('change', e => loadVideo(e.target.files[0], 'proj'));

async function loadVideo(file, type) {
  if (!file) return;
  const ctrl = type === 'ff' ? ffController : projController;
  $(`${type}-fps-status`).textContent = 'fps 측정 중...';
  await ctrl.load(file);
  updateFrameSlider(type);
  checkUploadReady();
}

function onFpsDetected(type, fps, auto) {
  const input = $(`${type}-fps-input`);
  input.value = fps;
  $(`${type}-fps-status`).textContent = auto ? `자동 감지: ${fps}fps` : `기본값: ${fps}fps (수동 입력 가능)`;
}

$('ff-fps-input').addEventListener('change', e => {
  ffController.setFps(Number(e.target.value));
  updateFrameSlider('ff');
});
$('proj-fps-input').addEventListener('change', e => {
  projController.setFps(Number(e.target.value));
  updateFrameSlider('proj');
});

function checkUploadReady() {
  const ffReady   = ffVideo.readyState >= 1;
  const projReady = projVideo.readyState >= 1;
  $('btn-to-track').disabled = !(ffReady && projReady);
}

$('btn-to-track').addEventListener('click', () => showScreen('track'));

// ── 트래킹 화면 ───────────────────────────────────────
function activeController() { return activeVideo === 'ff' ? ffController : projController; }
function activeCanvas()     { return activeVideo === 'ff' ? ffCanvas : projCanvas; }
function activeTracker()    { return activeVideo === 'ff' ? ffTracker : projTracker; }

// 영상 전환 탭
$('tab-ff').addEventListener('click',   () => switchVideo('ff'));
$('tab-proj').addEventListener('click', () => switchVideo('proj'));

function switchVideo(type) {
  activeVideo = type;
  $('tab-ff').classList.toggle('active', type === 'ff');
  $('tab-proj').classList.toggle('active', type === 'proj');

  // 캔버스 표시 전환
  ffCanvas.classList.toggle('hidden-canvas', type !== 'ff');
  projCanvas.classList.toggle('hidden-canvas', type !== 'proj');

  $('frame-slider').max = Math.max(0, activeController().totalFrames - 1);
  $('frame-slider').value = activeController().currentFrame;
  redraw();
  updateFrameInfo();
}

// 프레임 탐색
$('btn-prev').addEventListener('click', () => stepFrame(-1));
$('btn-next').addEventListener('click', () => stepFrame(1));
$('frame-slider').addEventListener('input', async e => {
  await activeController().seekToFrame(Number(e.target.value));
  redraw();
  updateFrameInfo();
});

async function stepFrame(delta) {
  const ctrl = activeController();
  const next = ctrl.currentFrame + delta;
  await ctrl.seekToFrame(Math.max(0, Math.min(next, ctrl.totalFrames - 1)));
  $('frame-slider').value = ctrl.currentFrame;
  redraw();
  updateFrameInfo();
}

function updateFrameInfo() {
  const ctrl = activeController();
  $('frame-info').textContent = `프레임 ${ctrl.currentFrame} / ${ctrl.totalFrames - 1}  (${ctrl.video.currentTime.toFixed(3)}s)`;
}

function updateFrameSlider(type) {
  if (activeVideo !== type) return;
  const ctrl = activeController();
  const slider = $('frame-slider');
  slider.max = Math.max(0, ctrl.totalFrames - 1);
  slider.value = 0;
  updateFrameInfo();
}

// 모드 버튼
$('btn-mode-calib').addEventListener('click', () => setMode('calibration'));
$('btn-mode-track').addEventListener('click', () => {
  if (!calibration.isCalibrated) {
    alert('기준 보정을 먼저 완료해주세요.');
    return;
  }
  setMode('tracking');
});
$('btn-mode-none').addEventListener('click', () => setMode(null));
$('btn-undo').addEventListener('click', () => {
  if (activeMode === 'tracking') {
    activeTracker().removeLast();
    redraw();
  } else if (activeMode === 'calibration') {
    calibration.points.pop();
    redraw();
  }
});

function setMode(mode) {
  activeMode = mode;
  ['calib','track','none'].forEach(m =>
    $(`btn-mode-${m}`).classList.toggle('active', mode === (m === 'none' ? null : m))
  );
  activeCanvas().style.cursor = mode ? 'crosshair' : 'default';
  $('mode-hint').textContent =
    mode === 'calibration' ? '자(ruler)의 양 끝점 두 곳을 클릭하세요' :
    mode === 'tracking'    ? '각 프레임에서 물체 중심을 클릭하세요' : '';
}

// 캔버스 클릭/터치
[ffCanvas, projCanvas].forEach(canvas => {
  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    const touch = e.changedTouches[0];
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    handleInput(canvas, (touch.clientX - rect.left) * scaleX, (touch.clientY - rect.top) * scaleY);
  }, { passive: false });
});

function onCanvasClick(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  const scaleX = e.currentTarget.width / rect.width;
  const scaleY = e.currentTarget.height / rect.height;
  handleInput(e.currentTarget, (e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY);
}

function handleInput(canvas, x, y) {
  if (!activeMode) return;
  const isActive = (activeVideo === 'ff' && canvas === ffCanvas) ||
                   (activeVideo === 'proj' && canvas === projCanvas);
  if (!isActive) return;

  if (activeMode === 'calibration') {
    const added = calibration.addPoint(x, y);
    if (calibration.points.length === 2) {
      const px = calibration.pixelDistance;
      const cm = prompt(`두 점 사이 픽셀 거리: ${px?.toFixed(1)}px\n실제 길이(cm)를 입력하세요:`);
      if (cm && !isNaN(cm)) {
        calibration.setRealLength(Number(cm));
        $('calib-status').textContent = `보정 완료: ${calibration.scale?.toFixed(4)} cm/px`;
        setMode(null);
      } else {
        calibration.reset();
      }
    }
  } else if (activeMode === 'tracking') {
    const ctrl = activeController();
    activeTracker().addPoint(x, y, ctrl.currentFrame, ctrl.fps);
    stepFrame(1); // 다음 프레임 자동 이동
  }

  redraw();
}

// 캔버스 재렌더링
function redraw() {
  const ctrl = activeController();
  const canvas = activeCanvas();
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctrl.drawCurrentFrame();
  calibration.draw(ctx);
  activeTracker().draw(ctx);
}

// ── 결과 화면 ─────────────────────────────────────────
$('btn-to-result').addEventListener('click', () => {
  showScreen('result');
  renderAllGraphs();
});

function renderAllGraphs() {
  const ffRel   = ffTracker.getRelativeData();
  const projRel = projTracker.getRelativeData();

  if (ffRel.length > 0)   graphs.renderFreeFall($('chart-ff'), ffRel);
  if (projRel.length > 0) graphs.renderProjectileX($('chart-proj-x'), projRel);
  if (ffRel.length > 0 && projRel.length > 0)
    graphs.renderProjectileY($('chart-proj-y'), ffRel, projRel);
}

$('btn-report').addEventListener('click', async () => {
  const name  = $('student-name').value.trim() || '이름없음';
  const cls   = $('student-class').value.trim() || '-';
  const date  = new Date().toLocaleDateString('ko-KR');

  await generateReport({
    studentName: name,
    className: cls,
    date,
    freeFallCanvas: ffCanvas,
    projectileCanvas: projCanvas,
    ffData: ffTracker.getRelativeData(),
    projData: projTracker.getRelativeData(),
    calibration,
    chartCanvases: {
      ffChart:    $('chart-ff'),
      projXChart: $('chart-proj-x'),
      projYChart: $('chart-proj-y'),
    }
  });
});
