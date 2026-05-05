// app.js — 메인 컨트롤러

import { initAuth, login, logout, isAdmin, checkDomainAccess } from './auth.js';
import { initAdmin }          from './admin.js';
import { VideoController }    from './video.js';
import { Calibration }        from './calibration.js';
import { Tracker }            from './tracker.js';
import { AutoTracker }        from './autotracker.js';
import { GraphRenderer }      from './graphs.js';
import { generateReport }     from './report.js';


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
// 'calibration' | 'tracking' | 'auto-box' | 'ml-select' | null(이동)
let activeMode  = null;
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

let dragState        = null;  // 박스 선택 드래그
let dragPoint        = null;  // 포인트 이동 드래그 { index }
let potentialDrag    = null;  // 탭 vs 드래그 구분 { index, startX, startY }
let selectedPointIdx = -1;    // 선택된 점 인덱스 (-1이면 없음)

// ── 인증 ─────────────────────────────────────────────
initAuth(
  async user => {
    currentUser = user;
    $('user-name').textContent = user.email;
    $('btn-logout').classList.remove('hidden');
    console.log('[AUTH]', user.email, '/ admin:', isAdmin(user));

    if (isAdmin(user)) {
      showScreen('admin');
      try { await initAdmin(user); }
      catch (e) { console.error(e); $('admin-init-error').textContent = '오류: ' + e.message; }
      return;
    }
    try {
      const { allowed, domain } = await checkDomainAccess(user);
      if (!allowed) { $('blocked-domain').textContent = domain; showScreen('blocked'); return; }
    } catch (e) { console.error('도메인 검증 오류:', e); }
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
  fitCanvases();
  checkUploadReady();
}

function onFpsDetected(type, fps, auto) {
  $(`${type}-fps-input`).value = fps;
  $(`${type}-fps-status`).textContent = auto ? `자동 감지: ${fps}fps` : `기본값: ${fps}fps`;
}

$('ff-fps-input').addEventListener('change',   e => { ffController.setFps(Number(e.target.value));   updateFrameSlider('ff');   });
$('proj-fps-input').addEventListener('change', e => { projController.setFps(Number(e.target.value)); updateFrameSlider('proj'); });

function checkUploadReady() {
  $('btn-to-track').disabled = !(ffVideo.readyState >= 1 && projVideo.readyState >= 1);
}

$('btn-to-track').addEventListener('click', () => {
  showScreen('track');
  // 화면 표시 후 레이아웃 계산 완료 시점에 맞춤
  requestAnimationFrame(() => requestAnimationFrame(fitCanvases));
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
  requestAnimationFrame(fitCanvases);
  redraw();
  updateFrameInfo();
}

// ── 프레임 탐색 ───────────────────────────────────────
$('btn-prev').addEventListener('click', () => stepFrame(-1));
$('btn-next').addEventListener('click', () => stepFrame(1));
$('frame-slider').addEventListener('input', async e => {
  await activeController().seekToFrame(Number(e.target.value));
  redraw();
  updateFrameInfo();
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
  $('btn-start-auto').disabled = true;
  $('auto-seed-status').textContent = '추적할 물체를 박스로 드래그하여 선택하세요';
  $('auto-progress-wrap').classList.add('hidden');
  $('auto-conf-bar-wrap').classList.add('hidden');
  $('auto-progress-bar').style.width = '0%';
  setMode('auto-box');
});
$('btn-mode-none').addEventListener('click', () => setMode(null));

$('btn-undo').addEventListener('click', () => {
  if (activeMode === 'calibration') {
    calibration.points.pop();
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
  setMode(null);
  redraw();
});

function setMode(mode) {
  activeMode = mode;
  selectedPointIdx = -1;
  const modeMap = { calibration: 'calib', tracking: 'track', 'auto-box': 'auto' };
  ['calib','track','auto','none'].forEach(m => {
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
    mode === null          ? '점을 드래그하여 위치 수정 가능' : '';
}

function updateCalibStatus() {
  const el = $('calib-status');
  if (calibration.isCalibrated) {
    el.textContent = `보정 완료: ${calibration.scale?.toFixed(4)} cm/px`;
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
    if (dragPoint) { dragPoint = null; activeCanvas().style.cursor = 'grab'; }
  });

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.touches[0];
    onPointerDown({ currentTarget: canvas, clientX: t.clientX, clientY: t.clientY });
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
    calibration.addPoint(x, y);
    if (calibration.points.length === 2) {
      const px = calibration.pixelDistance;
      const cm = prompt(`픽셀 거리: ${px?.toFixed(1)}px\n실제 길이(cm)를 입력하세요:`);
      if (cm && !isNaN(cm)) {
        calibration.setRealLength(Number(cm));
        updateCalibStatus();
        setMode(null);
      } else calibration.reset();
    }
    redraw();

  } else if (activeMode === 'tracking') {
    // 수동 트래킹: 클릭만, 자동 프레임 이동 없음 (← → 키 또는 버튼으로 이동)
    const ctrl = activeController();
    activeTracker().addPoint(x, y, ctrl.currentFrame, ctrl.fps);
    redraw();
  }
}

function onPointerMove(e) {
  if (!isActiveCanvas(e.currentTarget)) return;
  const { x, y } = canvasPoint(e.currentTarget, e.clientX, e.clientY);

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
  if (potentialDrag) {
    // 드래그 없이 탭 → 점 선택 / 선택 해제 토글
    selectedPointIdx = (selectedPointIdx === potentialDrag.index) ? -1 : potentialDrag.index;
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
$('btn-start-auto').addEventListener('click', runAutoTracking);

async function runAutoTracking() {
  const at = activeAutoTracker(), ctrl = activeController(), tracker = activeTracker();
  if (!at.seeded) { alert('먼저 물체를 선택하세요.'); return; }

  const interval  = Math.max(1, parseInt($('auto-interval').value)  || 1);
  const maxPoints = Math.max(1, parseInt($('auto-maxframes').value) || 20);
  const startFrame = ctrl.currentFrame;
  const endFrame   = Math.min(startFrame + interval * maxPoints, ctrl.totalFrames - 1);

  $('btn-start-auto').disabled = true;
  $('btn-stop-auto').disabled  = false;
  $('auto-progress-wrap').classList.remove('hidden');
  $('auto-conf-bar-wrap').classList.remove('hidden');

  let stopped = false, count = 0;
  $('btn-stop-auto').onclick = () => { stopped = true; };
  tracker.reset();

  const total = Math.ceil((endFrame - startFrame) / interval) + 1;

  for (let f = startFrame; f <= endFrame; f += interval) {
    if (stopped) break;

    await ctrl.seekToFrame(f);
    $('frame-slider').value = ctrl.currentFrame;

    const result = at.findInCanvas(activeCanvas(), interval);
    const { x, y, confidence, lowConfidence, outOfBounds } = result;

    // 화면 밖 이탈 또는 저신뢰도 → 즉시 중단
    if (outOfBounds) {
      $('auto-seed-status').textContent = '⚠️ 물체가 화면 밖으로 벗어남 — 추적 중단';
      break;
    }
    if (lowConfidence) {
      $('auto-seed-status').textContent = '⚠️ 신뢰도 낮음 — 추적 중단 (박스 재선택 후 다시 시도)';
      break;
    }

    at.updateVelocity(x, y);
    at.lastPos = { x, y };
    at.updateTemplate(activeCanvas(), x, y, confidence);
    tracker.addPoint(x, y, f, ctrl.fps, false);
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
  if (!$('auto-seed-status').textContent.startsWith('⚠️')) {
    $('auto-seed-status').textContent = `완료 — ${count}개 점 기록됨`;
  }
  setMode(null);
}

// ── 캔버스 재렌더링 ───────────────────────────────────
function redraw() {
  const ctrl = activeController(), canvas = activeCanvas();
  const ctx  = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctrl.drawCurrentFrame();
  calibration.draw(ctx);
  activeTracker().draw(ctx, activeVideo, selectedPointIdx);
}

// ── 결과 화면 ─────────────────────────────────────────
$('btn-to-result').addEventListener('click', () => { showScreen('result'); renderAllGraphs(); });

function renderAllGraphs() {
  const unit = calibration.unit;
  const ffRel = ffTracker.getRelativeData(), projRel = projTracker.getRelativeData();
  if (ffRel.length > 0)   graphs.renderFreeFall($('chart-ff'), ffRel, unit);
  if (projRel.length > 0) graphs.renderProjectileX($('chart-proj-x'), projRel, unit);
  if (ffRel.length > 0 && projRel.length > 0)
    graphs.renderProjectileY($('chart-proj-y'), ffRel, projRel, unit);
}

$('btn-report').addEventListener('click', async () => {
  const name = $('student-name').value.trim() || '이름없음';
  const cls  = $('student-class').value.trim() || '-';
  await generateReport({
    studentName: name, className: cls,
    date: new Date().toLocaleDateString('ko-KR'),
    freeFallCanvas: ffCanvas, projectileCanvas: projCanvas,
    ffData:   ffTracker.getRelativeData(),
    projData: projTracker.getRelativeData(),
    calibration,
    chartCanvases: { ffChart: $('chart-ff'), projXChart: $('chart-proj-x'), projYChart: $('chart-proj-y') }
  });
});
