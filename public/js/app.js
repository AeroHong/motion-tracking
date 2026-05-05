// app.js — 메인 컨트롤러

import { initAuth, login, logout, isAdmin, checkDomainAccess } from './auth.js';
import { initAdmin }       from './admin.js';
import { VideoController } from './video.js';
import { Calibration }     from './calibration.js';
import { Tracker }         from './tracker.js';
import { AutoTracker }     from './autotracker.js';
import { GraphRenderer }   from './graphs.js';
import { generateReport }  from './report.js';

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
let activeMode  = null;   // 'calibration' | 'tracking' | 'auto-box'
let activeVideo = 'ff';

const ffVideo    = $('ff-video');
const ffCanvas   = $('ff-canvas');
const projVideo  = $('proj-video');
const projCanvas = $('proj-canvas');

const calibration     = new Calibration();
const ffTracker       = new Tracker(calibration);
const projTracker     = new Tracker(calibration);
const ffAutoTracker   = new AutoTracker();
const projAutoTracker = new AutoTracker();
const graphs          = new GraphRenderer();

const ffController   = new VideoController(ffVideo,   ffCanvas,   (fps, auto) => onFpsDetected('ff',   fps, auto));
const projController = new VideoController(projVideo, projCanvas, (fps, auto) => onFpsDetected('proj', fps, auto));

// ── 박스 드래그 상태 ──────────────────────────────────
let dragState = null; // { startX, startY, endX, endY, active }

// ── 인증 ─────────────────────────────────────────────
initAuth(
  async user => {
    currentUser = user;
    $('user-name').textContent = user.displayName ?? user.email;
    $('btn-logout').classList.remove('hidden');

    if (isAdmin(user)) {
      showScreen('admin');
      try {
        await initAdmin(user);
      } catch (e) {
        console.error('관리자 초기화 오류:', e);
        $('admin-init-error').textContent = '초기화 오류: ' + e.message;
      }
      return;
    }

    try {
      const { allowed, domain } = await checkDomainAccess(user);
      if (!allowed) {
        $('blocked-domain').textContent = domain;
        showScreen('blocked');
        return;
      }
    } catch (e) {
      console.error('도메인 검증 오류:', e);
      // 오류 시 일단 통과 (Firestore 미설정 상태 대비)
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

function showScreen(name) {
  Object.values(screens).forEach(s => s?.classList.add('hidden'));
  screens[name]?.classList.remove('hidden');
}

// ── 영상 업로드 ───────────────────────────────────────
$('ff-file').addEventListener('change',   e => loadVideo(e.target.files[0], 'ff'));
$('proj-file').addEventListener('change', e => loadVideo(e.target.files[0], 'proj'));

async function loadVideo(file, type) {
  if (!file) return;
  $(`${type}-fps-status`).textContent = 'fps 측정 중...';
  await (type === 'ff' ? ffController : projController).load(file);
  updateFrameSlider(type);
  checkUploadReady();
}

function onFpsDetected(type, fps, auto) {
  $(`${type}-fps-input`).value = fps;
  $(`${type}-fps-status`).textContent = auto
    ? `자동 감지: ${fps}fps` : `기본값: ${fps}fps`;
}

$('ff-fps-input').addEventListener('change',   e => { ffController.setFps(Number(e.target.value));   updateFrameSlider('ff'); });
$('proj-fps-input').addEventListener('change', e => { projController.setFps(Number(e.target.value)); updateFrameSlider('proj'); });

function checkUploadReady() {
  $('btn-to-track').disabled = !(ffVideo.readyState >= 1 && projVideo.readyState >= 1);
}

$('btn-to-track').addEventListener('click', () => showScreen('track'));

// ── 트래킹 화면 헬퍼 ──────────────────────────────────
const activeController  = () => activeVideo === 'ff' ? ffController   : projController;
const activeCanvas      = () => activeVideo === 'ff' ? ffCanvas        : projCanvas;
const activeTracker     = () => activeVideo === 'ff' ? ffTracker       : projTracker;
const activeAutoTracker = () => activeVideo === 'ff' ? ffAutoTracker   : projAutoTracker;

// 영상 탭 전환
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

// ── 모드 전환 ─────────────────────────────────────────
$('btn-mode-calib').addEventListener('click', () => setMode('calibration'));
$('btn-mode-track').addEventListener('click', () => {
  if (!calibration.isCalibrated) { alert('기준 보정을 먼저 완료해주세요.'); return; }
  setMode('tracking');
});
$('btn-mode-auto').addEventListener('click', () => {
  if (!calibration.isCalibrated) { alert('기준 보정을 먼저 완료해주세요.'); return; }
  activeAutoTracker().reset();
  dragState = null;
  $('btn-start-auto').disabled = true;
  $('auto-seed-status').textContent = '추적할 물체를 드래그하여 박스로 선택하세요';
  $('auto-progress-wrap').classList.add('hidden');
  $('auto-progress-bar').style.width = '0%';
  setMode('auto-box');
});
$('btn-mode-none').addEventListener('click', () => setMode(null));
$('btn-undo').addEventListener('click', () => {
  if (activeMode === 'tracking') { activeTracker().removeLast(); redraw(); }
  else if (activeMode === 'calibration') { calibration.points.pop(); redraw(); }
});

function setMode(mode) {
  activeMode = mode;
  const modeMap = { calibration: 'calib', tracking: 'track', 'auto-box': 'auto' };
  ['calib','track','auto','none'].forEach(m => {
    $(`btn-mode-${m}`)?.classList.toggle('active', mode ? modeMap[mode] === m : m === 'none');
  });
  const canvas = activeCanvas();
  canvas.style.cursor =
    mode === 'auto-box'     ? 'crosshair' :
    mode === 'calibration'  ? 'crosshair' :
    mode === 'tracking'     ? 'crosshair' : 'default';

  $('auto-panel').classList.toggle('hidden', mode !== 'auto-box');
  $('mode-hint').textContent =
    mode === 'calibration' ? '자(ruler)의 양 끝점 두 곳을 클릭하세요' :
    mode === 'tracking'    ? '각 프레임에서 물체 중심을 클릭하세요'  : '';
}

// ── 캔버스 이벤트 (클릭/드래그) ──────────────────────
[ffCanvas, projCanvas].forEach(canvas => {
  // 마우스
  canvas.addEventListener('mousedown', onPointerDown);
  canvas.addEventListener('mousemove', onPointerMove);
  canvas.addEventListener('mouseup',   onPointerUp);

  // 터치
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.touches[0];
    onPointerDown({ currentTarget: canvas, clientX: t.clientX, clientY: t.clientY, type: 'touchstart' });
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const t = e.touches[0];
    onPointerMove({ currentTarget: canvas, clientX: t.clientX, clientY: t.clientY });
  }, { passive: false });
  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    const t = e.changedTouches[0];
    onPointerUp({ currentTarget: canvas, clientX: t.clientX, clientY: t.clientY });
  }, { passive: false });
});

function canvasPoint(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left)  * (canvas.width  / rect.width),
    y: (clientY - rect.top)   * (canvas.height / rect.height),
  };
}

function isActiveCanvas(canvas) {
  return (activeVideo === 'ff' && canvas === ffCanvas) ||
         (activeVideo === 'proj' && canvas === projCanvas);
}

function onPointerDown(e) {
  if (!isActiveCanvas(e.currentTarget)) return;
  const { x, y } = canvasPoint(e.currentTarget, e.clientX, e.clientY);

  if (activeMode === 'auto-box') {
    dragState = { startX: x, startY: y, endX: x, endY: y, active: true };
  } else if (activeMode === 'calibration') {
    calibration.addPoint(x, y);
    if (calibration.points.length === 2) {
      const px = calibration.pixelDistance;
      const cm = prompt(`픽셀 거리: ${px?.toFixed(1)}px\n실제 길이(cm)를 입력하세요:`);
      if (cm && !isNaN(cm)) {
        calibration.setRealLength(Number(cm));
        $('calib-status').textContent = `보정 완료: ${calibration.scale?.toFixed(4)} cm/px`;
        setMode(null);
      } else calibration.reset();
    }
    redraw();
  } else if (activeMode === 'tracking') {
    const ctrl = activeController();
    activeTracker().addPoint(x, y, ctrl.currentFrame, ctrl.fps);
    redraw();
    stepFrame(1);
  }
}

function onPointerMove(e) {
  if (!dragState?.active) return;
  if (!isActiveCanvas(e.currentTarget)) return;
  const { x, y } = canvasPoint(e.currentTarget, e.clientX, e.clientY);
  dragState.endX = x;
  dragState.endY = y;
  redraw();
  drawSelectionBox(activeCanvas());
}

function onPointerUp(e) {
  if (!dragState?.active) return;
  dragState.active = false;
  const { x, y } = canvasPoint(e.currentTarget, e.clientX, e.clientY);
  dragState.endX = x;
  dragState.endY = y;

  const bx = Math.min(dragState.startX, dragState.endX);
  const by = Math.min(dragState.startY, dragState.endY);
  const bw = Math.abs(dragState.endX - dragState.startX);
  const bh = Math.abs(dragState.endY - dragState.startY);

  if (bw < 10 || bh < 10) {
    $('auto-seed-status').textContent = '박스가 너무 작습니다. 다시 드래그하세요.';
    dragState = null;
    return;
  }

  activeAutoTracker().seedFromBox(activeCanvas(), bx, by, bw, bh);
  $('auto-seed-status').textContent = `선택 완료 (${Math.round(bw)}×${Math.round(bh)}px) — 설정 확인 후 추적 시작을 누르세요`;
  $('btn-start-auto').disabled = false;
  redraw();
  drawSelectionBox(activeCanvas());
}

// 선택 박스 오버레이 렌더링
function drawSelectionBox(canvas) {
  if (!dragState) return;
  const ctx = canvas.getContext('2d');
  const x = Math.min(dragState.startX, dragState.endX);
  const y = Math.min(dragState.startY, dragState.endY);
  const w = Math.abs(dragState.endX - dragState.startX);
  const h = Math.abs(dragState.endY - dragState.startY);

  ctx.save();
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth   = 2;
  ctx.setLineDash([6, 3]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);

  // 모서리 핸들
  const hs = 8;
  ctx.fillStyle = '#00e5ff';
  [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([px,py]) => {
    ctx.fillRect(px - hs/2, py - hs/2, hs, hs);
  });

  // 중심점
  ctx.beginPath();
  ctx.arc(x + w/2, y + h/2, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#ff5722';
  ctx.fill();
  ctx.restore();
}

// ── 자동 추적 실행 ────────────────────────────────────
$('btn-start-auto').addEventListener('click', runAutoTracking);

async function runAutoTracking() {
  const at      = activeAutoTracker();
  const ctrl    = activeController();
  const tracker = activeTracker();

  if (!at.seeded) { alert('먼저 물체를 드래그해서 선택하세요.'); return; }

  const interval   = Math.max(1, parseInt($('auto-interval').value)   || 1);
  const maxPoints  = Math.max(1, parseInt($('auto-maxframes').value)  || 20);
  const startFrame = ctrl.currentFrame;
  const endFrame   = Math.min(startFrame + interval * maxPoints, ctrl.totalFrames - 1);

  $('btn-start-auto').disabled  = true;
  $('btn-stop-auto').disabled   = false;
  $('auto-progress-wrap').classList.remove('hidden');

  let stopped = false;
  $('btn-stop-auto').onclick = () => { stopped = true; };

  tracker.reset();
  let count = 0;
  const total = Math.ceil((endFrame - startFrame) / interval) + 1;

  for (let f = startFrame; f <= endFrame; f += interval) {
    if (stopped) break;

    await ctrl.seekToFrame(f);
    $('frame-slider').value = ctrl.currentFrame;

    const { x, y } = at.findInCanvas(activeCanvas());
    at.lastPos = { x, y };
    at.updateTemplate(activeCanvas(), x, y);

    tracker.addPoint(x, y, f, ctrl.fps);
    redraw();
    // 현재 추적 박스 표시
    if (at.box) {
      const bx = x - at.thW, by = y - at.thH;
      dragState = { startX: bx, startY: by, endX: bx + at.thW*2, endY: by + at.thH*2, active: false };
      drawSelectionBox(activeCanvas());
    }

    count++;
    $('auto-progress-bar').style.width = Math.round((count / total) * 100) + '%';
    $('auto-progress-label').textContent = `${count} / ${total} 프레임 추적 중...`;
    updateFrameInfo();

    await new Promise(r => setTimeout(r, 0)); // UI 갱신 yield
  }

  $('btn-start-auto').disabled = false;
  $('btn-stop-auto').disabled  = true;
  $('auto-progress-label').textContent = stopped
    ? `중단 — ${count}개 점 기록됨` : `완료 — ${count}개 점 기록됨`;
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
  if (ffRel.length > 0)   graphs.renderFreeFall($('chart-ff'), ffRel);
  if (projRel.length > 0) graphs.renderProjectileX($('chart-proj-x'), projRel);
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
    chartCanvases: { ffChart: $('chart-ff'), projXChart: $('chart-proj-x'), projYChart: $('chart-proj-y') }
  });
});
