// app.js — 메인 컨트롤러

import { initAuth, login, logout, isAdmin, checkDomainAccess } from './auth.js';
import { initAdmin }       from './admin.js';
import { VideoController } from './video.js';
import { Calibration }     from './calibration.js';
import { Tracker }         from './tracker.js';
import { AutoTracker }     from './autotracker.js';
import { GraphRenderer }   from './graphs.js';
import { generateReport }  from './report.js';

// ── DOM 참조 ────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  login:   $('screen-login'),
  blocked: $('screen-blocked'),
  admin:   $('screen-admin'),
  upload:  $('screen-upload'),
  track:   $('screen-track'),
  result:  $('screen-result'),
};

let currentUser = null;
let activeMode  = null;   // 'calibration' | 'tracking' | 'auto-seed'
let activeVideo = 'ff';   // 'ff' | 'proj'

const ffVideo    = $('ff-video');
const ffCanvas   = $('ff-canvas');
const projVideo  = $('proj-video');
const projCanvas = $('proj-canvas');

const calibration   = new Calibration();
const ffTracker     = new Tracker(calibration);
const projTracker   = new Tracker(calibration);
const ffAutoTracker = new AutoTracker();
const projAutoTracker = new AutoTracker();
const graphs        = new GraphRenderer();

const ffController   = new VideoController(ffVideo, ffCanvas,   (fps, auto) => onFpsDetected('ff',   fps, auto));
const projController = new VideoController(projVideo, projCanvas, (fps, auto) => onFpsDetected('proj', fps, auto));

// ── 인증 ─────────────────────────────────────────────
initAuth(
  async user => {
    currentUser = user;
    $('user-name').textContent = user.displayName;
    $('btn-logout').classList.remove('hidden');

    if (isAdmin(user)) {
      showScreen('admin');
      await initAdmin(user);
      return;
    }

    const { allowed, domain } = await checkDomainAccess(user);
    if (!allowed) {
      $('blocked-domain').textContent = domain;
      showScreen('blocked');
      return;
    }

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
$('btn-blocked-logout').addEventListener('click', logout);

// ── 화면 전환 ─────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name]?.classList.remove('hidden');
}

// ── 영상 업로드 ───────────────────────────────────────
$('ff-file').addEventListener('change',   e => loadVideo(e.target.files[0], 'ff'));
$('proj-file').addEventListener('change', e => loadVideo(e.target.files[0], 'proj'));

async function loadVideo(file, type) {
  if (!file) return;
  $(`${type}-fps-status`).textContent = 'fps 측정 중...';
  const ctrl = type === 'ff' ? ffController : projController;
  await ctrl.load(file);
  updateFrameSlider(type);
  checkUploadReady();
}

function onFpsDetected(type, fps, auto) {
  $(`${type}-fps-input`).value = fps;
  $(`${type}-fps-status`).textContent = auto
    ? `자동 감지: ${fps}fps`
    : `기본값: ${fps}fps (수동 입력 가능)`;
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
  $('btn-to-track').disabled = !(ffVideo.readyState >= 1 && projVideo.readyState >= 1);
}

$('btn-to-track').addEventListener('click', () => showScreen('track'));

// ── 트래킹 화면 ───────────────────────────────────────
function activeController()  { return activeVideo === 'ff' ? ffController   : projController;   }
function activeCanvas()      { return activeVideo === 'ff' ? ffCanvas        : projCanvas;        }
function activeTracker()     { return activeVideo === 'ff' ? ffTracker       : projTracker;       }
function activeAutoTracker() { return activeVideo === 'ff' ? ffAutoTracker   : projAutoTracker;   }

// 영상 전환 탭
$('tab-ff').addEventListener('click',   () => switchVideo('ff'));
$('tab-proj').addEventListener('click', () => switchVideo('proj'));

function switchVideo(type) {
  activeVideo = type;
  $('tab-ff').classList.toggle('active',   type === 'ff');
  $('tab-proj').classList.toggle('active', type === 'proj');
  ffCanvas.classList.toggle('hidden-canvas',   type !== 'ff');
  projCanvas.classList.toggle('hidden-canvas', type !== 'proj');
  $('frame-slider').max   = Math.max(0, activeController().totalFrames - 1);
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
}

function updateFrameSlider(type) {
  if (activeVideo !== type) return;
  const ctrl = activeController();
  $('frame-slider').max   = Math.max(0, ctrl.totalFrames - 1);
  $('frame-slider').value = 0;
  updateFrameInfo();
}

// ── 모드 버튼 ─────────────────────────────────────────
$('btn-mode-calib').addEventListener('click', () => setMode('calibration'));
$('btn-mode-track').addEventListener('click', () => {
  if (!calibration.isCalibrated) { alert('기준 보정을 먼저 완료해주세요.'); return; }
  setMode('tracking');
});
$('btn-mode-auto').addEventListener('click', () => {
  if (!calibration.isCalibrated) { alert('기준 보정을 먼저 완료해주세요.'); return; }
  setMode('auto-seed');
});
$('btn-mode-none').addEventListener('click', () => setMode(null));
$('btn-undo').addEventListener('click', () => {
  if (activeMode === 'tracking' || activeMode === 'auto-seed') {
    activeTracker().removeLast();
    redraw();
  } else if (activeMode === 'calibration') {
    calibration.points.pop();
    redraw();
  }
});

function setMode(mode) {
  activeMode = mode;

  // 버튼 active 상태 동기화
  const modeMap = { calibration: 'calib', tracking: 'track', 'auto-seed': 'auto' };
  ['calib','track','auto','none'].forEach(m => {
    const btn = $(`btn-mode-${m}`);
    if (btn) btn.classList.toggle('active',
      mode ? modeMap[mode] === m : m === 'none'
    );
  });

  activeCanvas().style.cursor = mode ? 'crosshair' : 'default';

  // 자동 추적 패널 표시/숨김
  $('auto-panel').classList.toggle('hidden', mode !== 'auto-seed');

  $('mode-hint').textContent =
    mode === 'calibration' ? '자(ruler)의 양 끝점 두 곳을 클릭하세요' :
    mode === 'tracking'    ? '각 프레임에서 물체 중심을 클릭하세요' :
    mode === 'auto-seed'   ? '추적할 물체의 중심을 클릭하세요 (시드 지정)' : '';
}

// ── 캔버스 입력 (클릭/터치) ───────────────────────────
[ffCanvas, projCanvas].forEach(canvas => {
  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    const touch = e.changedTouches[0];
    const rect  = canvas.getBoundingClientRect();
    handleInput(canvas,
      (touch.clientX - rect.left) * (canvas.width  / rect.width),
      (touch.clientY - rect.top)  * (canvas.height / rect.height)
    );
  }, { passive: false });
});

function onCanvasClick(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  handleInput(e.currentTarget,
    (e.clientX - rect.left) * (e.currentTarget.width  / rect.width),
    (e.clientY - rect.top)  * (e.currentTarget.height / rect.height)
  );
}

function handleInput(canvas, x, y) {
  if (!activeMode) return;
  const isActive = (activeVideo === 'ff' && canvas === ffCanvas) ||
                   (activeVideo === 'proj' && canvas === projCanvas);
  if (!isActive) return;

  if (activeMode === 'calibration') {
    calibration.addPoint(x, y);
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
    redraw();

  } else if (activeMode === 'tracking') {
    const ctrl = activeController();
    activeTracker().addPoint(x, y, ctrl.currentFrame, ctrl.fps);
    redraw();
    stepFrame(1);

  } else if (activeMode === 'auto-seed') {
    // 시드 지정 → 프리뷰 박스 표시 후 자동 추적 대기
    const at = activeAutoTracker();
    at.seed(activeCanvas(), x, y);
    at.lastPos = { x, y };
    $('auto-seed-status').textContent = `시드 지정 완료 (${Math.round(x)}, ${Math.round(y)}) — 아래 설정 후 추적 시작`;
    $('btn-start-auto').disabled = false;
    redraw();
    // 시드 위치 미리보기 표시
    drawSeedPreview(activeCanvas(), x, y);
  }
}

function drawSeedPreview(canvas, x, y) {
  const ctx  = canvas.getContext('2d');
  const half = activeAutoTracker().th;
  ctx.save();
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth   = 2;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(x - half, y - half, half * 2, half * 2);
  ctx.setLineDash([]);
  ctx.fillStyle = '#00e5ff';
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ── 자동 추적 실행 ────────────────────────────────────
$('btn-start-auto').addEventListener('click', runAutoTracking);

async function runAutoTracking() {
  const at       = activeAutoTracker();
  const ctrl     = activeController();
  const tracker  = activeTracker();

  if (!at.seeded) { alert('먼저 물체를 클릭해 시드를 지정하세요.'); return; }

  const interval  = Math.max(1, parseInt($('auto-interval').value)  || 1);
  const maxFrames = Math.max(1, parseInt($('auto-maxframes').value) || 20);
  const startFrame = ctrl.currentFrame;
  const endFrame   = Math.min(startFrame + interval * maxFrames, ctrl.totalFrames - 1);

  // UI 잠금
  $('btn-start-auto').disabled   = true;
  $('btn-stop-auto').disabled    = false;
  $('auto-progress-wrap').classList.remove('hidden');
  let stopped = false;
  $('btn-stop-auto').onclick = () => { stopped = true; };

  tracker.reset();
  let count = 0;
  const total = Math.ceil((endFrame - startFrame) / interval);

  for (let f = startFrame; f <= endFrame; f += interval) {
    if (stopped) break;

    await ctrl.seekToFrame(f);
    $('frame-slider').value = ctrl.currentFrame;

    const { x, y } = at.findInCanvas(activeCanvas());
    at.lastPos = { x, y };
    at.updateTemplate(activeCanvas(), x, y); // 적응형 업데이트

    tracker.addPoint(x, y, f, ctrl.fps);
    redraw();
    drawSeedPreview(activeCanvas(), x, y);

    count++;
    const pct = Math.round((count / total) * 100);
    $('auto-progress-bar').style.width = pct + '%';
    $('auto-progress-label').textContent = `${count} / ${total} 프레임`;
    updateFrameInfo();

    // 다음 프레임 처리 전 짧게 yield (UI 갱신)
    await new Promise(r => setTimeout(r, 0));
  }

  // 완료
  $('btn-start-auto').disabled  = false;
  $('btn-stop-auto').disabled   = true;
  $('auto-seed-status').textContent = stopped
    ? `추적 중단 — ${count}개 점 기록`
    : `추적 완료 — ${count}개 점 기록`;
  setMode(null);
}

// ── 캔버스 재렌더링 ───────────────────────────────────
function redraw() {
  const ctrl   = activeController();
  const canvas = activeCanvas();
  const ctx    = canvas.getContext('2d');
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
  if (ffRel.length > 0)
    graphs.renderFreeFall($('chart-ff'), ffRel);
  if (projRel.length > 0)
    graphs.renderProjectileX($('chart-proj-x'), projRel);
  if (ffRel.length > 0 && projRel.length > 0)
    graphs.renderProjectileY($('chart-proj-y'), ffRel, projRel);
}

$('btn-report').addEventListener('click', async () => {
  const name = $('student-name').value.trim() || '이름없음';
  const cls  = $('student-class').value.trim() || '-';
  const date = new Date().toLocaleDateString('ko-KR');
  await generateReport({
    studentName: name, className: cls, date,
    freeFallCanvas: ffCanvas, projectileCanvas: projCanvas,
    ffData:   ffTracker.getRelativeData(),
    projData: projTracker.getRelativeData(),
    calibration,
    chartCanvases: {
      ffChart:    $('chart-ff'),
      projXChart: $('chart-proj-x'),
      projYChart: $('chart-proj-y'),
    }
  });
});
