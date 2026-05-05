// tracker.js — 프레임별 물체 위치 트래킹 (드래그 이동 + 십자선 지원)

export class Tracker {
  constructor(calibration) {
    this.calibration = calibration;
    this.points = [];
  }

  reset() { this.points = []; }

  addPoint(xPx, yPx, frame, fps, lowConf = false) {
    const tSec = frame / fps;
    const xUnit = this.calibration.toUnit(xPx);
    const yCm   = this.calibration.toUnit(yPx); // variable명 유지 (하위호환)
    this.points.push({ frame, tSec, xPx, yPx, xCm: xUnit, yCm, lowConf });
  }

  removeLast() { this.points.pop(); }

  // 드래그로 포인트 이동 지원
  findPointNear(x, y, radius = 18) {
    for (let i = this.points.length - 1; i >= 0; i--) {
      const p = this.points[i];
      const dx = p.xPx - x, dy = p.yPx - y;
      if (Math.sqrt(dx * dx + dy * dy) <= radius) return i;
    }
    return -1;
  }

  updatePoint(index, xPx, yPx) {
    const p = this.points[index];
    if (!p) return;
    p.xPx = xPx;
    p.yPx = yPx;
    p.xCm = this.calibration.toUnit(xPx);
    p.yCm = this.calibration.toUnit(yPx);
  }

  // 원점(첫 점) 기준 상대 좌표
  getRelativeData() {
    if (this.points.length === 0) return [];
    const origin = this.points[0];
    return this.points.map(p => ({
      ...p,
      relXCm: p.xCm !== null ? p.xCm - origin.xCm : null,
      relYCm: p.yCm !== null ? -(p.yCm - origin.yCm) : null,
    }));
  }

  draw(ctx) {
    if (this.points.length === 0) return;
    ctx.save();

    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const origin = this.points[0];

    // ── 첫 번째 점 기준 십자선 ────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(0, origin.yPx);     ctx.lineTo(W, origin.yPx);     ctx.stroke();
    ctx.beginPath(); ctx.moveTo(origin.xPx, 0);     ctx.lineTo(origin.xPx, H);     ctx.stroke();
    ctx.setLineDash([]);

    const nums = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩',
                  '⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'];

    this.points.forEach((p, i) => {
      // 연결선
      if (i > 0) {
        const prev = this.points[i - 1];
        ctx.beginPath();
        ctx.moveTo(prev.xPx, prev.yPx);
        ctx.lineTo(p.xPx, p.yPx);
        ctx.strokeStyle = 'rgba(255,255,0,0.55)';
        ctx.lineWidth   = 1.5;
        ctx.stroke();

        // 간격 거리 표시
        if (p.xCm !== null && prev.xCm !== null) {
          const dx   = p.xCm - prev.xCm;
          const dy   = p.yCm - prev.yCm;
          const dist = Math.sqrt(dx * dx + dy * dy).toFixed(1);
          const unit = this.calibration.unit;
          ctx.fillStyle = '#ffe082';
          ctx.font      = '11px sans-serif';
          ctx.fillText(`${dist}${unit}`, (prev.xPx + p.xPx) / 2 + 4, (prev.yPx + p.yPx) / 2 - 4);
        }
      }

      // 점
      ctx.beginPath();
      ctx.arc(p.xPx, p.yPx, 7, 0, Math.PI * 2);
      ctx.fillStyle   = p.lowConf ? 'rgba(255,152,0,0.85)' : 'rgba(255,87,34,0.85)';
      ctx.fill();
      ctx.strokeStyle = p.lowConf ? '#fff176' : '#fff';
      ctx.lineWidth   = p.lowConf ? 2 : 1.5;
      ctx.stroke();

      // 번호
      ctx.fillStyle = '#fff';
      ctx.font      = 'bold 13px sans-serif';
      ctx.fillText(nums[i] ?? `${i + 1}`, p.xPx + 9, p.yPx - 6);

      if (p.lowConf) {
        ctx.fillStyle = '#fff176';
        ctx.font      = '11px sans-serif';
        ctx.fillText('⚠', p.xPx - 14, p.yPx - 6);
      }
    });

    ctx.restore();
  }
}
