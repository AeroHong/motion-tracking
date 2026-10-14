// report.js — OffscreenCanvas 합성으로 보고서 PNG 생성

// Android Chrome은 DOM에 추가되지 않은 <a> 클릭이 무시됨
function _triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function generateReport(options) {
  const blob = await renderReportBlob(options);
  const { studentName, className, date } = options;
  _triggerDownload(blob, `운동분석_${studentName}_${className}_${date}.png`);
  return blob;
}

export async function renderReportBlob({
  studentName, className, date,
  freeFallCanvas, projectileCanvas,
  ffData, projData, ffCalibration, projCalibration, chartCanvases,
}) {
  // ── 캔버스 규격 ──────────────────────────────────────
  const W   = 1600;
  const PAD = 32;
  const ffUnit   = ffCalibration.unit;
  const projUnit = projCalibration.unit;

  // 궤적 이미지: 2열
  const IMG_COL_W = Math.floor((W - PAD * 3) / 2);   // 752
  const IMG_H     = 380;

  // 그래프: 3열
  const GR_COL_W = Math.floor((W - PAD * 4) / 3);    // 490
  const GR_H     = 340;

  // ── Y 좌표 ──────────────────────────────────────────
  const HDR_BOT = 68;                               // 헤더 구분선

  const imgLblY  = HDR_BOT + 22;                   //  90 — 궤적 라벨 기준선
  const imgY     = imgLblY + 28;                   // 118 — 이미지 상단
  const imgBotY  = imgY + IMG_H;                   // 498

  const grLblY   = imgBotY + 30;                   // 528 — 그래프 라벨 기준선
  const grY      = grLblY + 28;                    // 556 — 그래프 상단
  const grBotY   = grY + GR_H;                     // 896

  const ROW_H    = 30;
  const maxRows  = Math.max(ffData.length, projData.length);
  const tableY   = grBotY + 52;                    // 948
  const H        = tableY + ROW_H * (maxRows + 1) + 80;

  const oc  = new OffscreenCanvas(W, H);
  const ctx = oc.getContext('2d');

  // ── 배경 ────────────────────────────────────────────
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // ── 헤더 ────────────────────────────────────────────
  ctx.fillStyle = '#1a1a2e';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(`이름: ${studentName}　학번: ${className}　날짜: ${date}`, PAD, 46);
  _hline(ctx, HDR_BOT, PAD, W - PAD, '#cccccc');

  // ── 궤적 이미지 (2열) ─────────────────────────────
  const imgX = [PAD, PAD * 2 + IMG_COL_W];
  const imgLabels = ['자유낙하 궤적', '수평투사 궤적'];
  const imgSrcs   = [freeFallCanvas, projectileCanvas];

  imgLabels.forEach((lbl, i) => {
    _lbl(ctx, lbl, imgX[i], imgLblY);
    ctx.fillStyle = '#ebebeb';
    ctx.fillRect(imgX[i], imgY, IMG_COL_W, IMG_H);
    if (imgSrcs[i]) _drawFit(ctx, imgSrcs[i], imgX[i], imgY, IMG_COL_W, IMG_H);
  });

  _hline(ctx, imgBotY + 16, PAD, W - PAD, '#e0e0e0');

  // ── 그래프 (3열) ─────────────────────────────────
  const grX = [
    PAD,
    PAD * 2 + GR_COL_W,
    PAD * 3 + GR_COL_W * 2,
  ];
  const grLabels = [
    'y-t 그래프 (자유낙하)',
    'x-t 그래프 (수평투사)',
    'y-t 그래프 (수평투사)',
  ];
  const grSrcs = [
    chartCanvases.ffChart,
    chartCanvases.projXChart,
    chartCanvases.projYChart,
  ];

  grLabels.forEach((lbl, i) => {
    _lbl(ctx, lbl, grX[i], grLblY);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(grX[i], grY, GR_COL_W, GR_H);
    if (grSrcs[i]) ctx.drawImage(grSrcs[i], grX[i], grY, GR_COL_W, GR_H);
    ctx.strokeStyle = '#d0d0d0';
    ctx.lineWidth = 1;
    ctx.strokeRect(grX[i], grY, GR_COL_W, GR_H);
  });

  _hline(ctx, grBotY + 16, PAD, W - PAD, '#e0e0e0');

  // ── 데이터표 ─────────────────────────────────────
  _table(ctx, ffData, projData, ffUnit, projUnit, PAD, tableY, W - PAD * 2);

  // ── 보정 정보 ─────────────────────────────────────
  ctx.fillStyle = '#9e9e9e';
  ctx.font = '14px sans-serif';
  const t1 = ffCalibration.isCalibrated
    ? `자유낙하 보정: ${ffCalibration.pixelDistance?.toFixed(1)}px = ${ffCalibration.realLengthCm}cm  (${ffCalibration.scale?.toFixed(4)} cm/px)`
    : '자유낙하 보정: 미설정 (px 단위)';
  const t2 = projCalibration.isCalibrated
    ? `수평투사 보정: ${projCalibration.pixelDistance?.toFixed(1)}px = ${projCalibration.realLengthCm}cm  (${projCalibration.scale?.toFixed(4)} cm/px)`
    : '수평투사 보정: 미설정 (px 단위)';
  ctx.fillText(`${t1}　　${t2}`, PAD, H - 24);

  return oc.convertToBlob({ type: 'image/png' });
}

// ── 자유 물체 운동 보고서 ─────────────────────────────

export async function generateFreeMotionReport(options) {
  const blob = await renderFreeMotionReportBlob(options);
  const { studentName, className, date, motionLabel } = options;
  _triggerDownload(blob, `운동분석_${motionLabel}_${studentName}_${className}_${date}.png`);
  return blob;
}

export async function renderFreeMotionReportBlob({
  studentName, className, date, motionLabel,
  trackingCanvas,
  data,
  calibration,
  chartCanvases,
  fitLines = [],
}) {
  const W   = 1600;
  const PAD = 32;
  const unit = calibration.unit;

  const IMG_W    = W - PAD * 2;
  const IMG_H    = 340;
  const GR_COL_W = Math.floor((W - PAD * 4) / 3);
  const GR_H     = 300;

  const HDR_BOT = 68;
  const imgLblY = HDR_BOT + 22;
  const imgY    = imgLblY + 28;
  const imgBotY = imgY + IMG_H;

  const grLblY  = imgBotY + 30;
  const grY     = grLblY + 28;
  const grBotY  = grY + GR_H;

  const FIT_LINE_H = 26;
  const fitY    = grBotY + 52;
  const fitBotY = fitY + 28 + FIT_LINE_H * fitLines.length;

  const ROW_H   = 30;
  const tableY  = (fitLines.length ? fitBotY : grBotY) + 52;
  const H       = tableY + ROW_H * (data.length + 1) + 80;

  const oc  = new OffscreenCanvas(W, H);
  const ctx = oc.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // 헤더
  ctx.fillStyle = '#1a1a2e';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(`이름: ${studentName}　학번: ${className}　날짜: ${date}`, PAD, 46);
  _hline(ctx, HDR_BOT, PAD, W - PAD, '#cccccc');

  // 궤적 이미지
  _lbl(ctx, `${motionLabel} — 궤적`, PAD, imgLblY);
  ctx.fillStyle = '#ebebeb';
  ctx.fillRect(PAD, imgY, IMG_W, IMG_H);
  if (trackingCanvas) _drawFit(ctx, trackingCanvas, PAD, imgY, IMG_W, IMG_H);
  _hline(ctx, imgBotY + 16, PAD, W - PAD, '#e0e0e0');

  // 그래프 3열
  const grX      = [PAD, PAD * 2 + GR_COL_W, PAD * 3 + GR_COL_W * 2];
  const grLabels = ['x-t 그래프', 'y-t 그래프', 'x-y 궤적'];
  const grSrcs   = [chartCanvases.xtChart, chartCanvases.ytChart, chartCanvases.xyChart];

  grLabels.forEach((lbl, i) => {
    _lbl(ctx, lbl, grX[i], grLblY);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(grX[i], grY, GR_COL_W, GR_H);
    if (grSrcs[i]) ctx.drawImage(grSrcs[i], grX[i], grY, GR_COL_W, GR_H);
    ctx.strokeStyle = '#d0d0d0';
    ctx.lineWidth = 1;
    ctx.strokeRect(grX[i], grY, GR_COL_W, GR_H);
  });
  _hline(ctx, grBotY + 16, PAD, W - PAD, '#e0e0e0');

  // 회귀 분석
  if (fitLines.length) {
    _lbl(ctx, '회귀 분석', PAD, fitY);
    ctx.fillStyle = '#212121';
    ctx.font = '17px sans-serif';
    fitLines.forEach((l, i) => ctx.fillText(l, PAD, fitY + 30 + FIT_LINE_H * i));
    _hline(ctx, fitBotY + 16, PAD, W - PAD, '#e0e0e0');
  }

  // 데이터표
  _fmTable(ctx, data, unit, PAD, tableY, W - PAD * 2);

  // 보정 정보
  ctx.fillStyle = '#9e9e9e';
  ctx.font = '14px sans-serif';
  const calibText = calibration.isCalibrated
    ? `보정: ${calibration.pixelDistance?.toFixed(1)}px = ${calibration.realLengthCm}cm  (${calibration.scale?.toFixed(4)} cm/px)`
    : '보정: 미설정 (px 단위)';
  ctx.fillText(calibText, PAD, H - 24);

  return oc.convertToBlob({ type: 'image/png' });
}

function _fmTable(ctx, data, unit, x, y, width) {
  const cols = ['시간(s)', `x (${unit})`, `Δx (${unit})`, `y (${unit})`, `Δy (${unit})`];
  const colW  = width / cols.length;
  const ROW_H = 30;

  ctx.fillStyle = '#1565c0';
  ctx.fillRect(x, y, width, ROW_H);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 15px sans-serif';
  cols.forEach((c, i) => ctx.fillText(c, x + colW * i + 8, y + 21));

  for (let i = 0; i < data.length; i++) {
    const ry = y + ROW_H * (i + 1);
    const d  = data[i], pD = data[i - 1];
    const dx = (d.relXCm != null && pD?.relXCm != null) ? (d.relXCm - pD.relXCm).toFixed(2) : '-';
    const dy = (d.relYCm != null && pD?.relYCm != null) ? (d.relYCm - pD.relYCm).toFixed(2) : '-';
    ctx.fillStyle = i % 2 === 0 ? '#f5f7fa' : '#ffffff';
    ctx.fillRect(x, ry, width, ROW_H);
    ctx.fillStyle = '#212121'; ctx.font = '14px sans-serif';
    [
      d.relTSec?.toFixed(3) ?? '',
      d.relXCm?.toFixed(2)  ?? '-',
      dx,
      d.relYCm?.toFixed(2)  ?? '-',
      dy,
    ].forEach((v, j) => ctx.fillText(v, x + colW * j + 8, ry + 21));
  }

  ctx.strokeStyle = '#c8c8c8'; ctx.lineWidth = 1;
  const totalH = ROW_H * (data.length + 1);
  ctx.strokeRect(x, y, width, totalH);
  for (let i = 1; i < cols.length; i++) {
    ctx.beginPath(); ctx.moveTo(x + colW * i, y); ctx.lineTo(x + colW * i, y + totalH); ctx.stroke();
  }
  for (let i = 1; i <= data.length; i++) {
    ctx.beginPath(); ctx.moveTo(x, y + ROW_H * i); ctx.lineTo(x + width, y + ROW_H * i); ctx.stroke();
  }
}

// ── 헬퍼 ─────────────────────────────────────────────

// ── 자유 물체 운동: 결과 화면 배치 그대로의 보고서 PNG ─────────────────
// layout: [{id, x, y, w, h}] — 결과 화면 GridStack 12열 기준(조작 카드 제외, 위로 당겨 붙인 것)
export const REPORT_ROW_RATIO = 40 / 104;
export const REPORT_CARD_TITLES = {
  track: '궤적 이미지', xt: 'x-t 그래프', yt: 'y-t 그래프', xy: '궤적 (x-y)',
  table: '측정 데이터', fit: '회귀 분석',
};

export async function renderFreeMotionLayoutBlob({
  studentName, className, date, motionLabel,
  calibration, layout, trackCanvas, chartCanvases, data, fitLines = [],
}) {
  const W = 1600, PAD = 24, HDR = 92, GAP = 12, FOOT = 40;
  const cols  = Math.max(1, ...layout.map(c => c.x + c.w));   // 쓰인 열만으로 폭을 채운다
  const colW  = (W - PAD * 2) / cols;
  const ROW   = colW * REPORT_ROW_RATIO;   // 화면과 같은 가로세로 비율 (1280px 화면: 열 104px, 행 40px)
  const rows  = Math.max(1, ...layout.map(c => c.y + c.h));
  const H     = HDR + rows * ROW + FOOT;
  const unit  = calibration.unit;

  const oc  = new OffscreenCanvas(W, H);
  const ctx = oc.getContext('2d');
  ctx.fillStyle = '#f5f7fa'; ctx.fillRect(0, 0, W, H);

  // 머리말
  ctx.fillStyle = '#1a1a2e'; ctx.font = 'bold 30px sans-serif';
  ctx.fillText(motionLabel, PAD, 44);
  ctx.font = '20px sans-serif'; ctx.fillStyle = '#424242';
  ctx.fillText(`이름: ${studentName}   학번: ${className}   날짜: ${date}`, PAD, 76);
  ctx.textAlign = 'right'; ctx.fillStyle = '#757575'; ctx.font = '16px sans-serif';
  ctx.fillText(_calibText(calibration), W - PAD, 76);
  ctx.textAlign = 'left';

  const charts = { xt: chartCanvases.xtChart, yt: chartCanvases.ytChart, xy: chartCanvases.xyChart };

  for (const c of layout) {
    const x = PAD + c.x * colW + GAP / 2, y = HDR + c.y * ROW + GAP / 2;
    const w = c.w * colW - GAP,           h = c.h * ROW - GAP;
    // 카드 틀 + 제목줄
    ctx.save();
    _roundRectPath(ctx, x, y, w, h, 12);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.strokeStyle = '#dde3ee'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.clip();
    ctx.fillStyle = '#1565c0'; ctx.font = 'bold 19px sans-serif';
    ctx.fillText(REPORT_CARD_TITLES[c.id] || c.id, x + 16, y + 30);
    _hline(ctx, y + 44, x, x + w, '#e3e8f0');

    const cx = x + 14, cy = y + 54, cw = w - 28, ch = h - 66;
    if (c.id === 'track') {
      ctx.fillStyle = '#111'; ctx.fillRect(cx, cy, cw, ch);
      _drawFit(ctx, trackCanvas, cx, cy, cw, ch);
    } else if (charts[c.id]) {
      _drawFit(ctx, charts[c.id], cx, cy, cw, ch);
    } else if (c.id === 'fit') {
      ctx.fillStyle = '#212121';
      _wrapLines(ctx, fitLines, cx, cy + 4, cw, ch, 18);
    } else if (c.id === 'table') {
      _fitTable(ctx, data, unit, cx, cy, cw, ch);
    }
    ctx.restore();
  }

  ctx.fillStyle = '#9e9e9e'; ctx.font = '14px sans-serif';
  ctx.fillText('Motion Tracker — 자유 물체 운동 분석 보고서', PAD, H - 14);
  return oc.convertToBlob({ type: 'image/png' });
}

function _calibText(calibration) {
  return calibration.isCalibrated
    ? `보정: ${calibration.pixelDistance?.toFixed(1)}px = ${calibration.realLengthCm}cm  (${calibration.scale?.toFixed(4)} cm/px)`
    : '보정: 미설정 (px 단위)';
}

function _roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// 문단 목록을 폭에 맞춰 줄바꿈 — 영역을 넘치면 글자를 줄여 다시 시도
function _wrapLines(ctx, lines, x, y, w, h, size) {
  for (let fs = size; fs >= 11; fs -= 1) {
    ctx.font = `${fs}px sans-serif`;
    const lh = Math.round(fs * 1.5), out = [];
    for (const line of lines) {
      let cur = '';
      for (const word of line.split(' ')) {
        const next = cur ? cur + ' ' + word : word;
        if (ctx.measureText(next).width > w && cur) { out.push(cur); cur = word; } else cur = next;
      }
      out.push(cur);
    }
    if (out.length * lh <= h || fs === 11) {
      out.forEach((l, i) => ctx.fillText(l, x, y + fs + i * lh));
      return;
    }
  }
}

// 측정 데이터표 — 열 폭은 내용 길이에 맞추고, 행이 많으면 글자를 줄인다
function _fitTable(ctx, data, unit, x, y, w, h) {
  const head = ['#', '시간(s)', `x (${unit})`, `Δx`, `y (${unit})`, `Δy`];
  const f = (v, d = 2) => (v != null && isFinite(v)) ? v.toFixed(d) : '-';
  const rows = data.map((p, i) => {
    const q = data[i - 1];
    return [String(i + 1), f(p.relTSec, 3), f(p.relXCm),
            q ? f(p.relXCm - q.relXCm) : '-', f(p.relYCm), q ? f(p.relYCm - q.relYCm) : '-'];
  });
  const rowH = Math.max(14, Math.min(30, h / (rows.length + 1)));
  const fs   = Math.max(10, Math.round(rowH * 0.52));
  ctx.font = `bold ${fs}px sans-serif`;
  const colW = head.map((hd, j) => Math.max(
    ctx.measureText(hd).width,
    ...rows.map(r => ctx.measureText(r[j]).width)) + fs * 1.4);
  const scale = Math.min(1, w / colW.reduce((a, b) => a + b, 0));
  const cws   = colW.map(c => c * scale);
  const tw    = cws.reduce((a, b) => a + b, 0);

  ctx.fillStyle = '#1565c0'; ctx.fillRect(x, y, tw, rowH);
  const drawRow = (cells, ry, bold, color) => {
    ctx.font = `${bold ? 'bold ' : ''}${fs}px sans-serif`; ctx.fillStyle = color; ctx.textAlign = 'right';
    let cx = x;
    cells.forEach((t, j) => { ctx.fillText(t, cx + cws[j] - fs * 0.6, ry + rowH * 0.68); cx += cws[j]; });
    ctx.textAlign = 'left';
  };
  drawRow(head, y, true, '#ffffff');
  rows.forEach((r, i) => {
    const ry = y + rowH * (i + 1);
    if (ry + rowH > y + h + 1) return;
    ctx.fillStyle = i % 2 ? '#ffffff' : '#f5f7fa'; ctx.fillRect(x, ry, tw, rowH);
    drawRow(r, ry, false, '#212121');
  });
  ctx.strokeStyle = '#dde3ee'; ctx.lineWidth = 1;
  ctx.strokeRect(x, y, tw, Math.min(h, rowH * (rows.length + 1)));
}

function _hline(ctx, y, x0, x1, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
}

function _lbl(ctx, text, x, y) {
  ctx.fillStyle = '#1565c0';
  ctx.font = 'bold 19px sans-serif';
  ctx.fillText(text, x, y);
}

// 종횡비 유지 + 중앙 letterbox
function _drawFit(ctx, src, dx, dy, dw, dh) {
  if (!src || !src.width || !src.height) return;
  const r = Math.min(dw / src.width, dh / src.height);
  const w = src.width * r, h = src.height * r;
  ctx.drawImage(src, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
}

// ── 궤적 이미지 자르기 ─────────────────────────────────────────
// 첫번째·마지막 추적 점 기준 직사각형으로 캔버스를 잘라 반환.
// points가 2개 미만이거나 자른 영역이 너무 작으면 원본 반환.
export function cropTrajectoryCanvas(sourceCanvas, points, padding = 60) {
  if (!sourceCanvas || !points || points.length < 2) return sourceCanvas;

  const first = points[0];
  const last  = points[points.length - 1];

  const sx = Math.max(0, Math.round(Math.min(first.xPx, last.xPx) - padding));
  const sy = Math.max(0, Math.round(Math.min(first.yPx, last.yPx) - padding));
  const ex = Math.min(sourceCanvas.width,  Math.round(Math.max(first.xPx, last.xPx) + padding));
  const ey = Math.min(sourceCanvas.height, Math.round(Math.max(first.yPx, last.yPx) + padding));
  const sw = ex - sx;
  const sh = ey - sy;

  if (sw < 20 || sh < 20) return sourceCanvas;

  const c   = document.createElement('canvas');
  c.width   = sw;
  c.height  = sh;
  c.getContext('2d').drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return c;
}

function _table(ctx, ffData, projData, ffUnit, projUnit, x, y, width) {
  const cols = [
    '시간(s)',
    `자유낙하 y(${ffUnit})`, `Δy(${ffUnit})`,
    `수평투사 y(${projUnit})`, `Δy(${projUnit})`,
    `수평투사 x(${projUnit})`, `Δx(${projUnit})`,
  ];
  const colW    = width / cols.length;
  const ROW_H   = 30;
  const maxRows = Math.max(ffData.length, projData.length);

  // 헤더
  ctx.fillStyle = '#1565c0';
  ctx.fillRect(x, y, width, ROW_H);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 15px sans-serif';
  cols.forEach((c, i) => ctx.fillText(c, x + colW * i + 8, y + 21));

  // 데이터 행
  for (let i = 0; i < maxRows; i++) {
    const ry  = y + ROW_H * (i + 1);
    const ff  = ffData[i],   pr  = projData[i];
    const pfF = ffData[i-1], pfP = projData[i-1];
    const t    = ff?.relTSec ?? pr?.relTSec;
    const ffDy = (ff?.relYCm != null && pfF?.relYCm != null)
      ? (ff.relYCm - pfF.relYCm).toFixed(2) : '-';
    const prDy = (pr?.relYCm != null && pfP?.relYCm != null)
      ? (pr.relYCm - pfP.relYCm).toFixed(2) : '-';
    const prDx = (pr?.relXCm != null && pfP?.relXCm != null)
      ? (pr.relXCm - pfP.relXCm).toFixed(2) : '-';

    ctx.fillStyle = i % 2 === 0 ? '#f5f7fa' : '#ffffff';
    ctx.fillRect(x, ry, width, ROW_H);
    ctx.fillStyle = '#212121';
    ctx.font = '14px sans-serif';

    [
      typeof t === 'number' ? t.toFixed(3) : '',
      ff?.relYCm != null ? ff.relYCm.toFixed(2) : '-',
      ffDy,
      pr?.relYCm != null ? pr.relYCm.toFixed(2) : '-',
      prDy,
      pr?.relXCm != null ? pr.relXCm.toFixed(2) : '-',
      prDx,
    ].forEach((v, j) => ctx.fillText(v, x + colW * j + 8, ry + 21));
  }

  // 격자선
  ctx.strokeStyle = '#c8c8c8';
  ctx.lineWidth = 1;
  const totalH = ROW_H * (maxRows + 1);
  ctx.strokeRect(x, y, width, totalH);
  for (let i = 1; i < cols.length; i++) {
    ctx.beginPath();
    ctx.moveTo(x + colW * i, y); ctx.lineTo(x + colW * i, y + totalH);
    ctx.stroke();
  }
  for (let i = 1; i <= maxRows; i++) {
    ctx.beginPath();
    ctx.moveTo(x, y + ROW_H * i); ctx.lineTo(x + width, y + ROW_H * i);
    ctx.stroke();
  }
}
