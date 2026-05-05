// report.js — OffscreenCanvas 합성으로 보고서 PNG 생성

export async function generateReport(options) {
  const blob = await renderReportBlob(options);

  const { studentName, className, date } = options;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `운동분석_${studentName}_${className}_${date}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  return blob; // 클라우드 업로드용
}

export async function renderReportBlob({
  studentName,
  className,
  date,
  freeFallCanvas,
  projectileCanvas,
  ffData,
  projData,
  calibration,
  chartCanvases,
}) {
  const W = 1200;
  const H = 1600;
  const PAD = 20;
  const unit = calibration.unit;

  const oc = new OffscreenCanvas(W, H);
  const ctx = oc.getContext('2d');

  // 배경
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, W, H);

  // ── 헤더 ──────────────────────────────────────────
  ctx.fillStyle = '#e0e0e0';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(`이름: ${studentName}　학번: ${className}　날짜: ${date}`, PAD, 40);

  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD, 50); ctx.lineTo(W - PAD, 50); ctx.stroke();

  // ── 궤적 이미지 ───────────────────────────────────
  const imgY = 60;
  const imgW = (W - PAD * 3) / 2;
  const imgH = 300;

  _drawLabel(ctx, '자유낙하 궤적', PAD, imgY + 15);
  _drawLabel(ctx, '수평투사 궤적', PAD * 2 + imgW, imgY + 15);

  if (freeFallCanvas)    ctx.drawImage(freeFallCanvas,    PAD,            imgY + 25, imgW, imgH);
  if (projectileCanvas)  ctx.drawImage(projectileCanvas,  PAD * 2 + imgW, imgY + 25, imgW, imgH);

  // ── 그래프 ────────────────────────────────────────
  const graphY = imgY + imgH + 50;
  const graphW = (W - PAD * 4) / 3;
  const graphH = 260;

  _drawLabel(ctx, `y-t 그래프 (자유낙하)`, PAD, graphY + 15);
  _drawLabel(ctx, `x-t 그래프 (수평투사)`, PAD * 2 + graphW, graphY + 15);
  _drawLabel(ctx, 'y-t 비교', PAD * 3 + graphW * 2, graphY + 15);

  [chartCanvases.ffChart, chartCanvases.projXChart, chartCanvases.projYChart].forEach((c, i) => {
    if (c) ctx.drawImage(c, PAD + (graphW + PAD) * i, graphY + 25, graphW, graphH);
  });

  // ── 데이터표 ──────────────────────────────────────
  const tableY = graphY + graphH + 60;
  _drawTable(ctx, ffData, projData, unit, PAD, tableY, W - PAD * 2);

  // ── 보정 정보 ─────────────────────────────────────
  ctx.fillStyle = '#aaa';
  ctx.font = '14px sans-serif';
  if (calibration.isCalibrated) {
    ctx.fillText(
      `기준 보정: ${calibration.pixelDistance?.toFixed(1)}px = ${calibration.realLengthCm}cm  (scale: ${calibration.scale?.toFixed(4)} cm/px)`,
      PAD, H - 50
    );
  } else {
    ctx.fillText('기준 보정: 미설정 (px 단위)', PAD, H - 50);
  }

  return oc.convertToBlob({ type: 'image/png' });
}

function _drawLabel(ctx, text, x, y) {
  ctx.fillStyle = '#90caf9';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText(text, x, y);
}

function _drawTable(ctx, ffData, projData, unit, x, y, width) {
  const cols = [`시간(s)`, `자유낙하 y(${unit})`, `수평투사 x(${unit})`, `수평투사 y(${unit})`];
  const colW = width / cols.length;
  const rowH = 28;
  const maxRows = Math.max(ffData.length, projData.length);

  // 헤더
  ctx.fillStyle = '#37474f';
  ctx.fillRect(x, y, width, rowH);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 14px sans-serif';
  cols.forEach((c, i) => ctx.fillText(c, x + colW * i + 8, y + 19));

  for (let i = 0; i < maxRows; i++) {
    const ry = y + rowH * (i + 1);
    ctx.fillStyle = i % 2 === 0 ? '#263238' : '#1e272c';
    ctx.fillRect(x, ry, width, rowH);
    ctx.fillStyle = '#e0e0e0';
    ctx.font = '13px sans-serif';

    const ff = ffData[i];
    const pr = projData[i];
    // relTSec: 첫 점 기준 경과시간
    const t = ff?.relTSec ?? pr?.relTSec;

    ctx.fillText(typeof t === 'number' ? t.toFixed(3) : '', x + 8, ry + 19);
    ctx.fillText(ff?.relYCm  != null ? ff.relYCm.toFixed(2)  : '-', x + colW     + 8, ry + 19);
    ctx.fillText(pr?.relXCm  != null ? pr.relXCm.toFixed(2)  : '-', x + colW * 2 + 8, ry + 19);
    ctx.fillText(pr?.relYCm  != null ? pr.relYCm.toFixed(2)  : '-', x + colW * 3 + 8, ry + 19);
  }

  ctx.strokeStyle = '#455a64';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, rowH * (maxRows + 1));
}
