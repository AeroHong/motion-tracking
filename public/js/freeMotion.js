// freeMotion.js — 자유 물체 운동 분석 모드

import { VideoController }           from './video.js';
import { ZoomController }            from './zoomController.js';
import { Calibration }               from './calibration.js';
import { Tracker }                   from './tracker.js';
import { AutoTracker }               from './autotracker.js';
import { GraphRenderer }             from './graphs.js';
import { pickVideoFromDrive }        from './drivePicker.js';
import { generateFreeMotionReport }           from './report.js';
import { saveFreeMotionReportToCloud,
         loadAllFreeMotionReports,
         deleteFreeMotionReport }             from './saveReport.js';

const $ = id => document.getElementById(id);

let _show;

const st = {
  mode:           null,  // 'calibration'|'origin'|'tracking'|'auto-box'|'pan'|null
  origin:         null,  // { xPx, yPx }
  selectedIdx:    -1,
  hoverOriginIdx: -1,
  dragState:      null,
  dragPoint:      null,
  potentialDrag:  null,
  canResume:      false,
  calibDragIdx:   -1,
  panStart:       null,
};

let vc, calib, tracker, autoTracker, graphs, fmZoom;

// ─── 공개 초기화 ─────────────────────────────────────────────
export function initFreeMotion(showScreen) {
  _show       = showScreen;
  calib       = new Calibration();
  tracker     = new Tracker(calib);
  autoTracker = new AutoTracker();
  graphs      = new GraphRenderer();
  vc = new VideoController($('fm-video'), $('fm-canvas'), (fps, auto) => {
    $('fm-capture-fps').value = fps;
    $('fm-fps-status').textContent = auto ? `자동 감지: ${fps}fps` : `기본값: ${fps}fps`;
    _slider();
  });
  _bindUpload();
  _bindTrack();
}

// ─── 업로드 이벤트 ───────────────────────────────────────────
function _bindUpload() {
  $('fm-local-btn').addEventListener('click', () => $('fm-file-input').click());
  $('fm-drive-btn').addEventListener('click', async () => {
    const btn = $('fm-drive-btn');
    btn.disabled = true; btn.textContent = '불러오는 중...';
    try {
      const { blob, name } = await pickVideoFromDrive();
      $('fm-filename').textContent = `✓ ${name}`;
      await _loadVideo(blob);
    } catch (e) {
      if (e.message !== '취소됨') alert('영상을 불러올 수 없습니다.\n' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = '📂 드라이브';
    }
  });
  $('fm-file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    $('fm-filename').textContent = `✓ ${file.name}`;
    await _loadVideo(file);
    e.target.value = '';
  });
  $('fm-capture-fps').addEventListener('change', e => {
    const fps = Math.max(1, parseInt(e.target.value) || 1);
    e.target.value = fps;
    vc.setFps(fps);
    _slider();
  });
  $('fm-btn-start').addEventListener('click', () => {
    _show('free-track');
    requestAnimationFrame(() => requestAnimationFrame(_fit));
    _syncFps();
  });
  $('fm-btn-back-mode').addEventListener('click', () => _show('mode'));

  // 자유 물체 운동 보고서 목록 클릭 위임 (한 번만 등록)
  $('fm-report-list').addEventListener('click', async e => {
    const viewBtn = e.target.closest('.btn-view-report');
    if (viewBtn) { window._openReportModal?.(viewBtn.dataset.url); return; }

    const delBtn = e.target.closest('.btn-delete-report');
    if (delBtn) {
      if (!confirm('이 보고서를 삭제할까요?')) return;
      const row = delBtn.closest('.report-item');
      delBtn.disabled = true; delBtn.textContent = '…';
      try {
        await deleteFreeMotionReport({ docId: row.dataset.docId, storagePath: row.dataset.storePath });
        row.remove();
        if (!$('fm-report-list').children.length) $('fm-prev-report-card').classList.add('hidden');
      } catch (err) {
        alert('삭제 실패: ' + err.message);
        delBtn.disabled = false; delBtn.textContent = '🗑';
      }
    }
  });

  _checkFreeReport();
}

// ─── 트래킹 이벤트 ───────────────────────────────────────────
function _bindTrack() {
  $('fm-btn-back-upload').addEventListener('click', () => {
    if (tracker.points.length > 0 &&
        !confirm('트래킹 데이터가 있습니다. 영상 선택으로 돌아갈까요?')) return;
    _show('free-upload');
  });

  // 모드 버튼
  $('fm-btn-mode-calib').addEventListener('click',  () => _setMode('calibration'));
  $('fm-btn-mode-origin').addEventListener('click', () => _setMode('origin'));
  $('fm-btn-mode-track').addEventListener('click',  () => _setMode('tracking'));
  $('fm-btn-mode-none').addEventListener('click',   () => _setMode(null));
  $('fm-btn-mode-pan').addEventListener('click',    () => _setMode('pan'));
  $('fm-btn-mode-auto').addEventListener('click',   () => {
    autoTracker.reset();
    st.dragState = null; st.canResume = false;
    $('fm-btn-start-auto').disabled = true;
    $('fm-btn-resume-auto').classList.add('hidden');
    $('fm-auto-seed').textContent = '추적할 물체를 박스로 드래그하세요';
    $('fm-auto-prog-wrap').classList.add('hidden');
    $('fm-auto-conf-wrap').classList.add('hidden');
    _setMode('auto-box');
  });

  $('fm-btn-calib-confirm').addEventListener('click', () => {
    const cm = parseFloat($('fm-calib-real-cm').value);
    if (!cm || cm <= 0) { $('fm-calib-real-cm').focus(); return; }
    if (calib.points.length < 2) return;
    calib.setRealLength(cm);
    tracker.recomputeUnits();
    _calibStatus(); _hideCalibBar(); _setMode(null); _redraw();
  });

  $('fm-btn-calib-reset-pts').addEventListener('click', () => {
    calib.reset(); st.calibDragIdx = -1; _hideCalibBar(); _redraw();
  });

  $('fm-btn-undo').addEventListener('click', () => {
    if (st.mode === 'calibration') {
      calib.points.pop();
      if (calib.points.length < 2) _hideCalibBar();
    }
    else if (st.selectedIdx !== -1)   { tracker.removeAt(st.selectedIdx); st.selectedIdx = -1; }
    else                              tracker.removeLast();
    _redraw();
  });
  $('fm-btn-reset').addEventListener('click', () => {
    if (!confirm('모든 추적 데이터와 원점을 초기화할까요?')) return;
    tracker.reset(); autoTracker.reset();
    st.origin = null; st.dragState = null;
    $('fm-origin-bar').classList.add('hidden');
    _setMode(null); _redraw();
  });

  // 프레임 탐색
  $('fm-btn-prev').addEventListener('click', () => _step(-1));
  $('fm-btn-next').addEventListener('click', () => _step(1));
  $('fm-frame-slider').addEventListener('input', async e => {
    await vc.seekToFrame(Number(e.target.value)); _redraw(); _frameInfo();
  });
  $('fm-track-fps').addEventListener('change', e => {
    const fps = Math.max(1, parseInt(e.target.value) || 1);
    e.target.value = fps; $('fm-capture-fps').value = fps;
    vc.setFps(fps); tracker.recomputeTimes(fps); _slider(); _interval();
  });
  document.addEventListener('keydown', e => {
    if ($('screen-free-track').classList.contains('hidden')) return;
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); _step(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); _step(1); }
  });

  // 캔버스 이벤트
  const cvs = $('fm-canvas');
  cvs.addEventListener('mousedown',  _down);
  cvs.addEventListener('mousemove',  _move);
  cvs.addEventListener('mouseup',    _up);
  cvs.addEventListener('mouseleave', () => {
    st.potentialDrag = null;
    if (st.panStart) { st.panStart = null; cvs.style.cursor = 'grab'; }
    if (st.dragPoint) { st.dragPoint = null; cvs.style.cursor = 'grab'; }
    if (st.dragState?.active) st.dragState = null;
  });
  // 터치: ZoomController가 핀치줌(두 손가락) 담당, 한 손가락은 기존 핸들러로 위임
  fmZoom = new ZoomController(cvs, {
    onDown: _down, onMove: _move, onUp: _up,
    onZoom: scale => {
      const btn  = $('fm-btn-zoom-reset');
      const span = $('fm-zoom-indicator');
      if (!btn) return;
      if (scale <= 1) { btn.classList.add('hidden'); }
      else { span.textContent = `${scale.toFixed(1)}×`; btn.classList.remove('hidden'); }
    },
  });
  $('fm-btn-zoom-reset').addEventListener('click', () => fmZoom.reset());

  // 결과 화면
  $('fm-btn-to-result').addEventListener('click', () => {
    const name = $('fm-motion-name').value.trim() || '자유 물체 운동 분석';
    $('fm-result-title').textContent = name;
    $('fm-result-name-edit').value   = name;
    _updateResultInfo();
    _show('free-result');
    _renderGraphs();
  });
  $('fm-btn-back-track').addEventListener('click', () => _show('free-track'));
  $('fm-btn-apply-name').addEventListener('click', () => {
    const name = $('fm-result-name-edit').value.trim() || '자유 물체 운동 분석';
    $('fm-result-title').textContent = name;
    $('fm-motion-name').value = name;
    _renderGraphs();
  });

  _bindCopyTable();

  $('fm-btn-report').addEventListener('click', async () => {
    const btn = $('fm-btn-report');
    btn.disabled = true; btn.textContent = '생성 중...';
    const statusEl = $('fm-cloud-save-status');
    try {
      const studentName  = $('fm-student-name').value.trim()  || '이름없음';
      const className    = $('fm-student-class').value.trim() || '00000';
      const date         = new Date().toLocaleDateString('ko-KR').replace(/\s/g, '');
      const motionLabel  = $('fm-motion-name').value.trim()   || '자유물체운동';
      _redraw();
      const data = _getData();
      const pngBlob = await generateFreeMotionReport({
        studentName, className, date, motionLabel,
        trackingCanvas: $('fm-canvas'),
        data, calibration: calib,
        chartCanvases: {
          xtChart: $('fm-chart-xt'),
          ytChart: $('fm-chart-yt'),
          xyChart: $('fm-chart-xy'),
        },
      });

      if (statusEl) { statusEl.textContent = '☁ 저장 중...'; statusEl.style.color = 'var(--text-dim)'; }
      try {
        await saveFreeMotionReportToCloud({ studentName, className, motionLabel, data, calibration: calib, pngBlob });
        if (statusEl) { statusEl.textContent = '✅ 저장 완료 — 목록에 추가됨'; statusEl.style.color = '#2e7d32'; }
        _checkFreeReport();
      } catch (cloudErr) {
        console.warn('클라우드 저장 실패:', cloudErr);
        if (statusEl) { statusEl.textContent = '⚠ 클라우드 저장 실패 (로컬 다운로드는 완료됨)'; statusEl.style.color = '#e65100'; }
      }
    } catch (e) {
      alert('보고서 생성 실패: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = '📄 보고서 저장 (PNG)';
    }
  });

  // 자동 추적
  $('fm-btn-start-auto').addEventListener('click', () => _runAuto(false));
  $('fm-btn-resume-auto').addEventListener('click', () => _runAuto(true));

  // 리사이즈
  window.addEventListener('resize', _fit);
  if (window.ResizeObserver) new ResizeObserver(_fit).observe($('fm-canvas-wrapper'));
}

// ─── 모드 관리 ───────────────────────────────────────────────
function _showCalibBar() {
  if (calib.points.length < 2) return;
  $('fm-calib-px-dist').textContent = `픽셀 거리: ${calib.pixelDistance?.toFixed(1) ?? '-'}px`;
  $('fm-calib-real-cm').value = calib.realLengthCm ?? '';
  $('fm-calib-input-bar').classList.remove('hidden');
  $('fm-calib-real-cm').focus();
}

function _hideCalibBar() {
  $('fm-calib-input-bar').classList.add('hidden');
}

function _updateCalibBarDist() {
  if ($('fm-calib-input-bar').classList.contains('hidden')) return;
  $('fm-calib-px-dist').textContent = `픽셀 거리: ${calib.pixelDistance?.toFixed(1) ?? '-'}px`;
}

function _setMode(mode) {
  if (mode === 'origin' && tracker.points.length === 0) {
    alert('먼저 물체의 위치를 1개 이상 추적한 후 원점을 선택하세요.');
    return;
  }
  if (mode !== 'calibration') {
    st.calibDragIdx = -1;
    _hideCalibBar();
  }
  if (mode !== 'pan') st.panStart = null;
  if (mode !== 'origin') st.hoverOriginIdx = -1;
  st.mode = mode; st.selectedIdx = -1;
  const map = { calibration: 'calib', origin: 'origin', tracking: 'track', 'auto-box': 'auto', pan: 'pan' };
  ['calib', 'origin', 'track', 'auto', 'none', 'pan'].forEach(m =>
    $(`fm-btn-mode-${m}`)?.classList.toggle('active', mode ? map[mode] === m : m === 'none')
  );
  const cross = ['calibration', 'origin', 'tracking', 'auto-box'].includes(mode);
  $('fm-canvas').style.cursor = cross ? 'crosshair' : 'grab';
  $('fm-auto-panel').classList.toggle('hidden', mode !== 'auto-box');
  $('fm-mode-hint').textContent =
    mode === 'calibration' ? '자(ruler) 양 끝점 두 곳을 클릭하세요' :
    mode === 'origin'      ? '분석 점 위에 마우스를 올려 원점으로 설정할 점을 선택하세요' :
    mode === 'tracking'    ? '물체 중심을 클릭하세요 (← → 키로 프레임 이동)' :
    mode === 'auto-box'    ? '추적할 물체를 박스로 드래그하세요' :
    mode === 'pan'         ? '드래그로 화면을 이동하세요 (확대된 상태에서만 동작)' :
    '점 탭→선택(✕) / 재탭→삭제 / 드래그→이동';
  _calibStatus();
  _syncOriginBtn();
}

function _syncOriginBtn() {
  $('fm-btn-mode-origin').disabled = tracker.points.length === 0;
}

function _calibStatus() {
  const el = $('fm-calib-status');
  if (calib.isCalibrated) {
    el.textContent = `보정: ${calib.scale?.toFixed(4)} cm/px`;
    el.style.color = '#66bb6a';
  } else {
    el.textContent = '보정 없음 (px)';
    el.style.color = '#ffa726';
  }
}

// ─── 캔버스 포인터 ───────────────────────────────────────────
function _pt(e) {
  const cvs = $('fm-canvas');
  const r = cvs.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (cvs.width  / r.width),
    y: (e.clientY - r.top)  * (cvs.height / r.height),
  };
}

function _down(e) {
  const { x, y } = _pt(e);

  if (st.mode === 'pan') {
    st.panStart = { clientX: e.clientX, clientY: e.clientY };
    $('fm-canvas').style.cursor = 'grabbing';
    return;
  }

  if (st.mode === 'origin') {
    const pts = tracker.points;
    if (pts.length === 0) { _setMode(null); return; }
    let minD = Infinity, nearest = pts[0];
    pts.forEach(p => {
      const d = Math.hypot(p.xPx - x, p.yPx - y);
      if (d < minD) { minD = d; nearest = p; }
    });
    st.origin = { xPx: nearest.xPx, yPx: nearest.yPx };
    const unitStr = calib.isCalibrated
      ? `(${calib.toUnit(0).toFixed(1)}, ${calib.toUnit(0).toFixed(1)}) — 해당 점 기준`
      : `(${nearest.xPx.toFixed(0)}, ${nearest.yPx.toFixed(0)}) px`;
    $('fm-origin-bar').classList.remove('hidden');
    $('fm-origin-coords').textContent = `점 ${pts.indexOf(nearest) + 1}번 선택됨`;
    _setMode(null); _redraw(); return;
  }

  if (st.mode === null) {
    const idx = tracker.findPointNear(x, y);
    if (idx !== -1) st.potentialDrag = { index: idx, startX: x, startY: y };
    else { st.selectedIdx = -1; _redraw(); }
    return;
  }

  if (st.mode === 'auto-box') {
    st.dragState = { startX: x, startY: y, endX: x, endY: y, active: true }; return;
  }

  if (st.mode === 'calibration') {
    if (calib.isOnButton(x, y)) {
      _showCalibBar();
      return;
    }
    const nearIdx = calib.findPointNear(x, y);
    if (nearIdx !== -1) {
      st.calibDragIdx = nearIdx;
    } else if (calib.points.length < 2) {
      calib.addPoint(x, y);
    }
    _redraw(); return;
  }

  if (st.mode === 'tracking') {
    const fps  = Math.max(1, parseInt($('fm-track-fps').value) || 30);
    const tSec = vc.currentFrame / fps;
    tracker.addPoint(x, y, vc.currentFrame, tSec);
    _redraw(); return;
  }
}

function _move(e) {
  const { x, y } = _pt(e);
  const cvs = $('fm-canvas');

  if (st.mode === 'origin') {
    const pts = tracker.points;
    if (pts.length === 0) return;
    let minD = Infinity, minIdx = -1;
    pts.forEach((p, i) => {
      const d = Math.hypot(p.xPx - x, p.yPx - y);
      if (d < minD) { minD = d; minIdx = i; }
    });
    if (st.hoverOriginIdx !== minIdx) { st.hoverOriginIdx = minIdx; _redraw(); }
    return;
  }

  if (st.panStart && st.mode === 'pan') {
    const dx = e.clientX - st.panStart.clientX;
    const dy = e.clientY - st.panStart.clientY;
    fmZoom.pan(dx, dy);
    st.panStart = { clientX: e.clientX, clientY: e.clientY };
    return;
  }

  if (st.calibDragIdx !== -1 && st.mode === 'calibration') {
    calib.movePoint(st.calibDragIdx, x, y);
    _updateCalibBarDist();
    if (calib.realLengthCm) {
      calib.setRealLength(calib.realLengthCm);
      tracker.recomputeUnits();
      _calibStatus();
    }
    _redraw(); return;
  }

  if (st.potentialDrag) {
    const dx = x - st.potentialDrag.startX, dy = y - st.potentialDrag.startY;
    if (Math.sqrt(dx*dx + dy*dy) > 5) {
      st.dragPoint = { index: st.potentialDrag.index };
      st.potentialDrag = null;
      cvs.style.cursor = 'grabbing';
    }
  }
  if (st.dragPoint) { tracker.updatePoint(st.dragPoint.index, x, y); _redraw(); return; }
  if (st.dragState?.active) { st.dragState.endX = x; st.dragState.endY = y; _redraw(); _drawBox(cvs); }
}

function _up(e) {
  if (st.panStart) {
    st.panStart = null;
    $('fm-canvas').style.cursor = 'grab';
    return;
  }
  if (st.calibDragIdx !== -1) {
    st.calibDragIdx = -1;
    return;
  }
  if (st.potentialDrag) {
    if (st.selectedIdx === st.potentialDrag.index) {
      tracker.removeAt(st.potentialDrag.index); st.selectedIdx = -1;
    } else {
      st.selectedIdx = st.potentialDrag.index;
      const pt = tracker.points[st.selectedIdx];
      if (pt !== undefined) {
        vc.seekToFrame(pt.frame).then(() => {
          $('fm-frame-slider').value = vc.currentFrame;
          _frameInfo();
          _redraw();
        });
      }
    }
    st.potentialDrag = null; _redraw(); return;
  }
  if (st.dragPoint) { st.dragPoint = null; $('fm-canvas').style.cursor = 'grab'; return; }
  if (!st.dragState?.active) return;

  const { x, y } = _pt(e);
  st.dragState.active = false; st.dragState.endX = x; st.dragState.endY = y;
  const bx = Math.min(st.dragState.startX, st.dragState.endX);
  const by = Math.min(st.dragState.startY, st.dragState.endY);
  const bw = Math.abs(st.dragState.endX - st.dragState.startX);
  const bh = Math.abs(st.dragState.endY - st.dragState.startY);

  if (bw < 10 || bh < 10) {
    $('fm-auto-seed').textContent = '박스가 너무 작습니다. 다시 드래그하세요.';
    st.dragState = null; return;
  }
  autoTracker.seedFromBox($('fm-canvas'), bx, by, bw, bh);
  $('fm-auto-seed').textContent = `선택 완료 (${Math.round(bw)}×${Math.round(bh)}px) — 추적 시작을 누르세요`;
  $('fm-btn-start-auto').disabled = false;
  _redraw(); _drawBox($('fm-canvas'));
}

// ─── 자동 추적 ───────────────────────────────────────────────
async function _runAuto(resume) {
  if (!autoTracker.seeded) { alert('먼저 물체를 선택하세요.'); return; }
  const interval  = Math.max(1, parseInt($('fm-auto-interval').value)  || 1);
  const maxPoints = Math.max(1, parseInt($('fm-auto-maxframes').value) || 20);
  const fps       = Math.max(1, parseInt($('fm-track-fps').value)      || 30);

  let startFrame;
  if (resume) {
    const last = tracker.points[tracker.points.length - 1];
    if (!last) { alert('재개할 데이터가 없습니다.'); return; }
    await vc.seekToFrame(last.frame); _redraw();
    autoTracker.resumeFrom($('fm-canvas'), last.xPx, last.yPx);
    startFrame = last.frame + interval;
  } else {
    startFrame = vc.currentFrame; tracker.reset();
  }
  const endFrame = Math.min(startFrame + interval * maxPoints, vc.totalFrames - 1);

  $('fm-btn-resume-auto').classList.add('hidden'); st.canResume = false;
  $('fm-btn-start-auto').disabled = true;
  $('fm-btn-stop-auto').disabled  = false;
  $('fm-auto-prog-wrap').classList.remove('hidden');
  $('fm-auto-conf-wrap').classList.remove('hidden');

  let stopped = false, count = 0;
  const total = Math.ceil((endFrame - startFrame) / interval) + 1;
  $('fm-btn-stop-auto').onclick = () => { stopped = true; };

  for (let f = startFrame; f <= endFrame; f += interval) {
    if (stopped) break;
    await vc.seekToFrame(f);
    $('fm-frame-slider').value = vc.currentFrame;

    const { x, y, confidence, lowConfidence, outOfBounds } =
      autoTracker.findInCanvas($('fm-canvas'), interval);

    if (outOfBounds) {
      $('fm-auto-seed').textContent = '⚠️ 물체가 화면 밖으로 벗어남 — 추적 중단';
      st.canResume = true; break;
    }
    if (lowConfidence) $('fm-auto-seed').textContent = '⚠️ 신뢰도 낮음 — 계속 추적 중';

    autoTracker.updateVelocity(x, y);
    autoTracker.lastPos = { x, y };
    autoTracker.updateTemplate($('fm-canvas'), x, y, confidence);
    tracker.addPoint(x, y, f, f / fps, false);
    _redraw();

    st.dragState = {
      startX: x - autoTracker.thW, startY: y - autoTracker.thH,
      endX:   x + autoTracker.thW, endY:   y + autoTracker.thH,
      active: false, lowConf: false,
    };
    _drawBox($('fm-canvas'));

    const pct = Math.round(confidence * 100);
    $('fm-auto-conf-bar').style.width      = pct + '%';
    $('fm-auto-conf-bar').style.background =
      confidence > 0.7 ? '#66bb6a' : confidence > 0.5 ? '#ffa726' : '#ef5350';
    $('fm-auto-conf-label').textContent    = `신뢰도 ${pct}%`;
    count++;
    $('fm-auto-prog-bar').style.width    = Math.round((count / total) * 100) + '%';
    $('fm-auto-prog-label').textContent  = `${count} / ${total}`;
    _frameInfo();
    await new Promise(r => setTimeout(r, 500));
  }

  $('fm-btn-start-auto').disabled = false;
  $('fm-btn-stop-auto').disabled  = true;

  if (st.canResume && !stopped) {
    $('fm-btn-resume-auto').classList.remove('hidden');
    $('fm-auto-seed').textContent += ' — 마지막 점 드래그 보정 후 이어서 추적 가능';
    _setMode(null); $('fm-auto-panel').classList.remove('hidden');
  } else {
    if (!$('fm-auto-seed').textContent.startsWith('⚠️'))
      $('fm-auto-seed').textContent = `완료 — ${count}개 점 기록됨`;
    _setMode(null);
  }
}

// ─── 캔버스 그리기 ───────────────────────────────────────────
function _redraw() {
  const cvs = $('fm-canvas');
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0, 0, cvs.width, cvs.height);
  vc.drawCurrentFrame();
  calib.draw(ctx);
  _drawOrigin(ctx, cvs);
  _drawPoints(ctx, cvs);
  if (st.dragState) _drawBox(cvs);
  _syncOriginBtn();
}

function _drawOrigin(ctx, cvs) {
  if (!st.origin) return;
  const { xPx: ox, yPx: oy } = st.origin;
  const W = cvs.width, H = cvs.height;
  ctx.save();
  // 좌표축 점선
  ctx.strokeStyle = 'rgba(255,215,0,0.55)'; ctx.lineWidth = 1.5; ctx.setLineDash([8, 5]);
  ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(W, oy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ox, 0); ctx.lineTo(ox, H); ctx.stroke();
  ctx.setLineDash([]);
  // 원점 원
  ctx.beginPath(); ctx.arc(ox, oy, 9, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd700'; ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#000'; ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('O', ox, oy);
  // 축 레이블
  ctx.fillStyle = '#ffd700'; ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  if (W - ox > 50) ctx.fillText('+x →', ox + 14, oy - 6);
  if (H - oy > 24) ctx.fillText('+y ↓', ox + 6, H - 8);
  ctx.restore();
}

const NUMS = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩',
              '⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'];

function _drawPoints(ctx, cvs) {
  const pts = tracker.points;
  if (pts.length === 0) return;
  ctx.save();
  // 가이드 선 (h + v, 각 점)
  pts.forEach(p => {
    ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(100,210,255,0.5)';
    ctx.beginPath(); ctx.moveTo(0, p.yPx); ctx.lineTo(cvs.width, p.yPx); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.xPx, 0); ctx.lineTo(p.xPx, cvs.height); ctx.stroke();
    ctx.setLineDash([]);
  });
  // 연결선
  for (let i = 1; i < pts.length; i++) {
    const pp = pts[i - 1], p = pts[i];
    ctx.beginPath(); ctx.moveTo(pp.xPx, pp.yPx); ctx.lineTo(p.xPx, p.yPx);
    ctx.strokeStyle = 'rgba(255,255,0,0.55)'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  // 점 + 번호 + 좌표
  pts.forEach((p, i) => {
    const sel     = i === st.selectedIdx;
    const hovOrg  = st.mode === 'origin' && i === st.hoverOriginIdx;

    // 원점 선택 모드 호버 하이라이트
    if (hovOrg) {
      ctx.beginPath(); ctx.arc(p.xPx, p.yPx, 18, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 3; ctx.setLineDash([5, 3]);
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#ffd700'; ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('원점으로 설정', p.xPx, p.yPx - 20);
    }

    ctx.beginPath(); ctx.arc(p.xPx, p.yPx, sel ? 10 : 7, 0, Math.PI * 2);
    ctx.fillStyle   = hovOrg ? 'rgba(255,215,0,0.9)' :
                      p.lowConf ? 'rgba(255,152,0,0.85)' : 'rgba(255,87,34,0.85)';
    ctx.fill();
    ctx.strokeStyle = hovOrg ? '#fff' : sel ? '#ffeb3b' : '#fff';
    ctx.lineWidth   = sel ? 3 : 1.5; ctx.stroke();

    ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(NUMS[i] ?? `${i + 1}`, p.xPx + 11, p.yPx - 7);

    // 원점 기준 좌표 표시
    if (st.origin) {
      const xR = calib.toUnit(p.xPx - st.origin.xPx).toFixed(1);
      const yR = calib.toUnit(p.yPx - st.origin.yPx).toFixed(1);
      ctx.fillStyle = '#ffe082'; ctx.font = '10px sans-serif';
      ctx.fillText(`(${xR}, ${yR}) ${calib.unit}`, p.xPx + 11, p.yPx + 8);
    }
    if (sel) {
      ctx.fillStyle = '#ffeb3b'; ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('✕', p.xPx - 20, p.yPx - 7);
    }
  });
  ctx.restore();
}

function _drawBox(cvs) {
  if (!st.dragState) return;
  const ctx = cvs.getContext('2d');
  const x = Math.min(st.dragState.startX, st.dragState.endX);
  const y = Math.min(st.dragState.startY, st.dragState.endY);
  const w = Math.abs(st.dragState.endX - st.dragState.startX);
  const h = Math.abs(st.dragState.endY - st.dragState.startY);
  const col = st.dragState.lowConf ? '#ffa726' : '#00e5ff';
  ctx.save();
  ctx.strokeStyle = col; ctx.lineWidth = 2;
  ctx.setLineDash(st.dragState.active ? [6, 3] : []);
  ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
  ctx.fillStyle = col;
  [[x, y],[x+w, y],[x, y+h],[x+w, y+h]].forEach(([px, py]) => ctx.fillRect(px-4, py-4, 8, 8));
  ctx.restore();
}

// ─── 결과 화면 정보 표시 ──────────────────────────────────────
function _updateResultInfo() {
  const originEl = $('fm-result-origin-info');
  const coordEl  = $('fm-result-origin-coords');
  const calibEl  = $('fm-result-calib-info');

  if (st.origin) {
    const ox = calib.isCalibrated
      ? `x=${calib.toUnit(st.origin.xPx).toFixed(1)}${calib.unit}, y=${calib.toUnit(st.origin.yPx).toFixed(1)}${calib.unit}`
      : `x=${st.origin.xPx.toFixed(0)}px, y=${st.origin.yPx.toFixed(0)}px`;
    coordEl.textContent = ox + ' (상대 좌표 기준)';
    originEl.classList.remove('hidden');
  } else {
    originEl.classList.add('hidden');
  }

  calibEl.textContent = calib.isCalibrated
    ? `보정: ${calib.scale.toFixed(4)} cm/px (기준 ${calib.realLengthCm}cm)`
    : '보정 없음 — px 단위로 표시됩니다.';
}

// ─── 그래프 + 테이블 ─────────────────────────────────────────
function _renderGraphs() {
  const data  = _getData();
  const unit  = calib.unit;
  const label = $('fm-motion-name').value.trim() || '자유 물체 운동';
  if (data.length === 0) return;
  graphs.renderFreeXT($('fm-chart-xt'), data, unit, label);
  graphs.renderFreeYT($('fm-chart-yt'), data, unit, label);
  graphs.renderFreeXY($('fm-chart-xy'), data, unit, label);
  _renderTable(data, unit);
}

function _renderTable(data, unit) {
  const wrap = $('fm-data-table-wrap');
  if (!wrap || data.length === 0) return;
  const u = unit;
  const fmt = (v, d = 2) => (v != null && !isNaN(v)) ? v.toFixed(d) : '-';

  let html = `<table class="data-table">
    <thead><tr>
      <th>번호</th><th>시간(s)</th>
      <th>x (${u})</th><th>Δx (${u})</th>
      <th>y (${u})</th><th>Δy (${u})</th>
    </tr></thead><tbody>`;

  data.forEach((p, i) => {
    const prev = data[i - 1];
    const dx   = prev != null ? p.relXCm - prev.relXCm : null;
    const dy   = prev != null ? p.relYCm - prev.relYCm : null;
    html += `<tr>
      <td>${i + 1}</td>
      <td>${fmt(p.relTSec, 3)}</td>
      <td>${fmt(p.relXCm)}</td><td>${dx != null ? fmt(dx) : '-'}</td>
      <td>${fmt(p.relYCm)}</td><td>${dy != null ? fmt(dy) : '-'}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// 클립보드 복사
function _bindCopyTable() {
  $('fm-btn-copy-table').addEventListener('click', () => {
    const data = _getData();
    if (!data.length) return;
    const u = calib.unit;
    const fmt = (v, d = 2) => (v != null && !isNaN(v)) ? v.toFixed(d) : '';
    const header = ['번호', '시간(s)', `x(${u})`, `Δx(${u})`, `y(${u})`, `Δy(${u})`].join('\t');
    const lines = data.map((p, i) => {
      const prev = data[i - 1];
      const dx   = prev != null ? p.relXCm - prev.relXCm : null;
      const dy   = prev != null ? p.relYCm - prev.relYCm : null;
      return [
        i + 1, fmt(p.relTSec, 3),
        fmt(p.relXCm), dx != null ? fmt(dx) : '',
        fmt(p.relYCm), dy != null ? fmt(dy) : '',
      ].join('\t');
    });
    const tsv = [header, ...lines].join('\n');
    const statusEl = $('fm-copy-status');
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
}

function _fallbackCopy(text, onDone) {
  const ta = document.createElement('textarea');
  ta.value = text;
  Object.assign(ta.style, { position: 'fixed', opacity: '0', top: '0', left: '0' });
  document.body.appendChild(ta);
  ta.focus(); ta.select(); ta.setSelectionRange(0, 99999);
  try { document.execCommand('copy'); onDone(); } catch { alert('복사 실패: 수동으로 복사해 주세요.'); }
  document.body.removeChild(ta);
}

function _getData() {
  const pts = tracker.points;
  if (pts.length === 0) return [];
  const t0 = pts[0].tSec;
  return pts.map(p => ({
    ...p,
    relTSec: p.tSec - t0,
    relXCm:  st.origin ? calib.toUnit(p.xPx - st.origin.xPx) : p.xCm,
    relYCm:  st.origin ? calib.toUnit(p.yPx - st.origin.yPx) : p.yCm,
  }));
}

// ─── 헬퍼 ────────────────────────────────────────────────────
async function _loadVideo(file) {
  $('fm-fps-status').textContent = 'fps 측정 중...';
  tracker.reset(); calib.reset(); autoTracker.reset();
  st.origin = null; st.dragState = null; st.selectedIdx = -1;
  $('fm-origin-bar').classList.add('hidden');
  fmZoom?.reset();
  await vc.load(file);
  _slider();
  $('fm-btn-start').disabled = false;
}
function _slider() {
  $('fm-frame-slider').max   = Math.max(0, vc.totalFrames - 1);
  $('fm-frame-slider').value = 0;
  _frameInfo();
}
function _frameInfo() {
  $('fm-frame-info').textContent =
    `프레임 ${vc.currentFrame} / ${vc.totalFrames - 1}  (${vc.video.currentTime.toFixed(3)}s)`;
  _interval();
}
function _interval() {
  const cap = Math.max(1, parseInt($('fm-track-fps').value) || 30);
  $('fm-track-interval').textContent = `1프레임=${(1 / cap).toFixed(4)}s`;
}
function _syncFps() {
  $('fm-track-fps').value = $('fm-capture-fps').value;
  _interval();
}
async function _step(d) {
  const next = Math.max(0, Math.min(vc.currentFrame + d, vc.totalFrames - 1));
  await vc.seekToFrame(next);
  $('fm-frame-slider').value = vc.currentFrame;
  _redraw(); _frameInfo();
}
function _fit() {
  const wrapper = $('fm-canvas-wrapper');
  if (!wrapper) return;
  const cvs = $('fm-canvas');
  const ww = wrapper.clientWidth, wh = wrapper.clientHeight;
  if (!ww || !wh || !cvs.width || !cvs.height) return;
  const scale = Math.min(ww / cvs.width, wh / cvs.height);
  cvs.style.width  = Math.round(cvs.width  * scale) + 'px';
  cvs.style.height = Math.round(cvs.height * scale) + 'px';
}

// ── 자유 물체 운동 보고서 목록 ────────────────────────────
async function _checkFreeReport() {
  try {
    const list      = await loadAllFreeMotionReports();
    const container = $('fm-report-list');
    const card      = $('fm-prev-report-card');
    if (!container || !card) return;
    container.innerHTML = '';
    if (!list.length) { card.classList.add('hidden'); return; }

    list.forEach((meta, i) => {
      const dt      = meta.createdAt?.toDate?.();
      const dateStr = dt ? dt.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' }) : '';
      const timeStr = dt ? dt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';

      const row = document.createElement('div');
      row.className = 'report-item';
      row.dataset.docId     = meta.id;
      row.dataset.storePath = meta.storagePath || '';
      row.innerHTML = `
        <div class="report-item-info">
          <span class="report-item-seq">${i + 1}회</span>
          <span class="report-item-name">${meta.studentName || ''} ${meta.className || ''}</span>
          <span class="report-item-date">${meta.motionLabel || ''} · ${dateStr} ${timeStr}</span>
        </div>
        <div class="report-item-actions">
          <button class="btn-view-report" data-url="${meta.reportUrl}">👁 보기</button>
          <a href="${meta.reportUrl}" class="btn-dl" target="_blank" rel="noopener" download>📥 다운로드</a>
          <button class="btn-delete-report btn-reset">🗑</button>
        </div>
      `;
      container.appendChild(row);
    });

    card.classList.remove('hidden');

  } catch (e) { console.warn('자유 물체 운동 보고서 목록 로드 실패:', e); }
}
