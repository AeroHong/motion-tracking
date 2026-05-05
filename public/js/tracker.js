// tracker.js — 프레임별 물체 위치 클릭 트래킹

export class Tracker {
  constructor(calibration) {
    this.calibration = calibration;
    this.points = []; // { frame, tSec, xPx, yPx, xCm, yCm }
  }

  reset() {
    this.points = [];
  }

  addPoint(xPx, yPx, frame, fps, lowConf = false) {
    const tSec = frame / fps;
    const xCm = this.calibration.toCm(xPx);
    const yCm = this.calibration.toCm(yPx);
    this.points.push({ frame, tSec, xPx, yPx, xCm, yCm, lowConf });
  }

  removeLast() {
    this.points.pop();
  }

  // 원점(첫 점) 기준 상대 좌표 반환
  getRelativeData() {
    if (this.points.length === 0) return [];
    const origin = this.points[0];
    return this.points.map(p => ({
      ...p,
      relXCm: p.xCm !== null ? p.xCm - origin.xCm : null,
      relYCm: p.yCm !== null ? -(p.yCm - origin.yCm) : null, // y축 반전 (아래→양수)
    }));
  }

  draw(ctx) {
    if (this.points.length === 0) return;
    ctx.save();

    const circleNumbers = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩',
                           '⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'];

    this.points.forEach((p, i) => {
      // 점 (저신뢰도는 주황색 + 경고 표시)
      ctx.beginPath();
      ctx.arc(p.xPx, p.yPx, 7, 0, Math.PI * 2);
      ctx.fillStyle = p.lowConf ? 'rgba(255, 152, 0, 0.85)' : 'rgba(255, 87, 34, 0.85)';
      ctx.fill();
      ctx.strokeStyle = p.lowConf ? '#fff176' : '#fff';
      ctx.lineWidth = p.lowConf ? 2 : 1.5;
      ctx.stroke();

      // 번호
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(circleNumbers[i] ?? `${i+1}`, p.xPx + 9, p.yPx - 6);
      if (p.lowConf) {
        ctx.fillStyle = '#fff176';
        ctx.font = '11px sans-serif';
        ctx.fillText('⚠', p.xPx - 14, p.yPx - 6);
      }

      // 이전 점과의 연결선 + 거리 표시
      if (i > 0) {
        const prev = this.points[i - 1];
        ctx.beginPath();
        ctx.moveTo(prev.xPx, prev.yPx);
        ctx.lineTo(p.xPx, p.yPx);
        ctx.strokeStyle = 'rgba(255, 255, 0, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        if (p.xCm !== null && prev.xCm !== null) {
          const dx = p.xCm - prev.xCm;
          const dy = p.yCm - prev.yCm;
          const dist = Math.sqrt(dx*dx + dy*dy).toFixed(1);
          const mx = (prev.xPx + p.xPx) / 2;
          const my = (prev.yPx + p.yPx) / 2;
          ctx.fillStyle = '#ffe082';
          ctx.font = '11px sans-serif';
          ctx.fillText(`${dist}cm`, mx + 4, my - 4);
        }
      }
    });

    ctx.restore();
  }
}
