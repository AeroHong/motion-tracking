// report.js — OffscreenCanvas 합성으로 보고서 PNG 생성

export async function generateReport({
  studentName,
  className,
  date,
  freeFallCanvas,
  projectileCanvas,
  ffData,
  projData,
  calibration,
  chartCanvases, // { ffChart, projXChart, projYChart }
}) {
  const W = 1200;
  const H = 1600;
  const PAD = 20;

  const oc = new OffscreenCanvas(W, H);
  const ctx = oc.getContext('2d');

  // 배경
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, W, H);

  // ── 헤더 ──────────────────────────────────────────
  ctx.fillStyle = '#e0e0e0';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(`이름: ${studentName}　반: ${className}　날짜: ${date}`, PAD, 40);

  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD, 50); ctx.lineTo(W - PAD, 50); ctx.stroke();

  // ── 궤적 이미지 ───────────────────────────────────
  const imgY = 60;
  const imgW = (W - PAD * 3) / 2;
  const imgH = 300;

  _drawLabel(ctx, '자유낙하 궤적', PAD, imgY + 15);
  _drawLabel(ctx, '수평투사 궤적', PAD * 2 + imgW, imgY + 15);

  if (freeFallCanvas) {
    ctx.drawImage(freeFallCanvas, PAD, imgY + 25, imgW, imgH);
  }
  if (projectileCanvas) {
    ctx.drawImage(projectileCanvas, PAD * 2 + imgW, imgY + 25, imgW, imgH);
  }

  // ── 그래프 ────────────────────────────────────────
  const graphY = imgY + imgH + 50;
  const graphW = (W - PAD * 4) / 3;
  const graphH = 260;

  _drawLabel(ctx, 'y-t 그래프 (자유낙하)', PAD, graphY + 15);
  _drawLabel(ctx, 'x-t 그래프 (수평투사)', PAD * 2 + graphW, graphY + 15);
  _drawLabel(ctx, 'y-t 비교', PAD * 3 + graphW * 2, graphY + 15);

  const charts = [chartCanvases.ffChart, chartCanvases.projXChart, chartCanvases.projYChart];
  charts.forEach((c, i) => {
    if (c) ctx.drawImage(c, PAD + (graphW + PAD) * i, graphY + 25, graphW, graphH);
  });

  // ── 데이터표 ──────────────────────────────────────
  const tableY = graphY + graphH + 60;
  _drawTable(ctx, ffData, projData, PAD, tableY, W - PAD * 2);

  // ── 보정 정보 ─────────────────────────────────────
  const calY = H - 50;
  ctx.fillStyle = '#aaa';
  ctx.font = '14px sans-serif';
  if (calibration.isCalibrated) {
    ctx.fillText(
      `기준 보정: ${calibration.pixelDistance?.toFixed(1)}px = ${calibration.realLengthCm}cm  (scale: ${calibration.scale?.toFixed(4)} cm/px)`,
      PAD, calY
    );
  } else {
    ctx.fillText('기준 보정: 미설정', PAD, calY);
  }

  // ── 다운로드 ──────────────────────────────────────
  const blob = await oc.convertToBlob({ type: 'image/png' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `운동분석_${studentName}_${className}_${date}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function _drawLabel(ctx, text, x, y) {
  ctx.fillStyle = '#90caf9';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText(text, x, y);
}

function _drawTable(ctx, ffData, projData, x, y, width) {
  const cols = ['시간(s)', '자유낙하 y(cm)', '수평투사 x(cm)', '수평투사 y(cm)'];
  const colW = width / cols.length;
  const rowH = 28;
  const maxRows = Math.max(ffData.length, projData.length);

  // 헤더
  ctx.fillStyle = '#37474f';
  ctx.fillRect(x, y, width, rowH);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 14px sans-serif';
  cols.forEach((c, i) => ctx.fillText(c, x + colW * i + 8, y + 19));

  // 행
  const rel_ff = ffData;
  const rel_proj = projData;

  for (let i = 0; i < maxRows; i++) {
    const ry = y + rowH * (i + 1);
    ctx.fillStyle = i % 2 === 0 ? '#263238' : '#1e272c';
    ctx.fillRect(x, ry, width, rowH);
    ctx.fillStyle = '#e0e0e0';
    ctx.font = '13px sans-serif';

    const ff = rel_ff[i];
    const pr = rel_proj[i];
    const tSec = ff?.tSec ?? pr?.tSec ?? '';

    ctx.fillText(typeof tSec === 'number' ? tSec.toFixed(3) : '', x + 8, ry + 19);
    ctx.fillText(ff?.relYCm != null ? ff.relYCm.toFixed(2) : '-', x + colW + 8, ry + 19);
    ctx.fillText(pr?.relXCm != null ? pr.relXCm.toFixed(2) : '-', x + colW * 2 + 8, ry + 19);
    ctx.fillText(pr?.relYCm != null ? pr.relYCm.toFixed(2) : '-', x + colW * 3 + 8, ry + 19);
  }

  // 테두리
  ctx.strokeStyle = '#455a64';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, rowH * (maxRows + 1));
}
