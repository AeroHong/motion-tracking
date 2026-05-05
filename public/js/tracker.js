// tracker.js — 프레임별 물체 위치 트래킹

export class Tracker {
  constructor(calibration) {
    this.calibration = calibration;
    this.points = [];
  }

  reset() { this.points = []; }

  addPoint(xPx, yPx, frame, fps, lowConf = false) {
    const tSec = frame / fps;
    const xUnit = this.calibration.toUnit(xPx);
    const yCm   = this.calibration.toUnit(yPx);
    this.points.push({ frame, tSec, xPx, yPx, xCm: xUnit, yCm, lowConf });
  }

  removeLast() { this.points.pop(); }

  removeAt(index) {
    if (index >= 0 && index < this.points.length) {
      this.points.splice(index, 1);
    }
  }

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

  getRelativeData() {
    if (this.points.length === 0) return [];
    const origin = this.points[0];
    return this.points.map(p => ({
      ...p,
      relXCm: p.xCm !== null ? p.xCm - origin.xCm : null,
      relYCm: p.yCm !== null ? -(p.yCm - origin.yCm) : null,
    }));
  }

  // type: 'ff' | 'proj'
  // selectedIdx: 선택된 점 인덱스 (-1이면 없음)
  draw(ctx, type = 'ff', selectedIdx = -1) {
    if (this.points.length === 0) return;
    ctx.save();

    const W = ctx.canvas.width;
    const H = ctx.canvas.height;

    // ── 첫 번째 점 기준 원점 십자선 (흰색 반투명) ────────
    const origin = this.points[0];
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(0, origin.yPx); ctx.lineTo(W, origin.yPx); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(origin.xPx, 0); ctx.lineTo(origin.xPx, H); ctx.stroke();
    ctx.setLineDash([]);

    // ── 각 점의 가이드 선 ─────────────────────────────────
    this.points.forEach(p => {
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);

      if (type === 'ff') {
        // 자유낙하: 가로 점선만 (하늘색)
        ctx.strokeStyle = 'rgba(100, 210, 255, 0.45)';
        ctx.beginPath(); ctx.moveTo(0, p.yPx); ctx.lineTo(W, p.yPx); ctx.stroke();
      } else {
        // 수평투사: 가로(하늘색) + 세로(연두색)
        ctx.strokeStyle = 'rgba(100, 210, 255, 0.45)';
        ctx.beginPath(); ctx.moveTo(0, p.yPx); ctx.lineTo(W, p.yPx); ctx.stroke();
        ctx.strokeStyle = 'rgba(100, 255, 160, 0.45)';
        ctx.beginPath(); ctx.moveTo(p.xPx, 0); ctx.lineTo(p.xPx, H); ctx.stroke();
      }
      ctx.setLineDash([]);
    });

    // ── 연결선 + 거리 표시 ────────────────────────────────
    const nums = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩',
                  '⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'];

    this.points.forEach((p, i) => {
      if (i > 0) {
        const prev = this.points[i - 1];
        ctx.beginPath();
        ctx.moveTo(prev.xPx, prev.yPx);
        ctx.lineTo(p.xPx, p.yPx);
        ctx.strokeStyle = 'rgba(255,255,0,0.55)';
        ctx.lineWidth   = 1.5;
        ctx.stroke();

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

      // 점 (선택된 점은 더 크게, 노란 테두리)
      const isSelected = i === selectedIdx;
      const radius = isSelected ? 10 : 7;
      ctx.beginPath();
      ctx.arc(p.xPx, p.yPx, radius, 0, Math.PI * 2);
      ctx.fillStyle   = p.lowConf ? 'rgba(255,152,0,0.85)' : 'rgba(255,87,34,0.85)';
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#ffeb3b' : (p.lowConf ? '#fff176' : '#fff');
      ctx.lineWidth   = isSelected ? 3 : (p.lowConf ? 2 : 1.5);
      ctx.stroke();

      // 번호
      ctx.fillStyle = '#fff';
      ctx.font      = 'bold 13px sans-serif';
      ctx.fillText(nums[i] ?? `${i + 1}`, p.xPx + 11, p.yPx - 7);

      // 선택된 점: ✕ 삭제 표시
      if (isSelected) {
        ctx.fillStyle = '#ffeb3b';
        ctx.font      = 'bold 14px sans-serif';
        ctx.fillText('✕', p.xPx - 19, p.yPx - 7);
      }

      if (p.lowConf && !isSelected) {
        ctx.fillStyle = '#fff176';
        ctx.font      = '11px sans-serif';
        ctx.fillText('⚠', p.xPx - 14, p.yPx - 6);
      }
    });

    ctx.restore();
  }
}
