// calibration.js — 두 점 클릭으로 px → cm 보정

export class Calibration {
  constructor() {
    this.points = [];   // 최대 2개
    this.scale = null;  // cm / px
    this.realLengthCm = null;
  }

  reset() {
    this.points = [];
    this.scale = null;
    this.realLengthCm = null;
  }

  addPoint(x, y) {
    if (this.points.length >= 2) return false;
    this.points.push({ x, y });
    return true;
  }

  get pixelDistance() {
    if (this.points.length < 2) return null;
    const dx = this.points[1].x - this.points[0].x;
    const dy = this.points[1].y - this.points[0].y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  setRealLength(cm) {
    const px = this.pixelDistance;
    if (!px || px === 0) return false;
    this.realLengthCm = cm;
    this.scale = cm / px;
    return true;
  }

  toCm(px) {
    if (!this.scale) return null;
    return px * this.scale;
  }

  get isCalibrated() {
    return this.scale !== null;
  }

  draw(ctx) {
    if (this.points.length === 0) return;
    ctx.save();
    ctx.strokeStyle = '#00e5ff';
    ctx.fillStyle = '#00e5ff';
    ctx.lineWidth = 2;

    this.points.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText(i === 0 ? 'A' : 'B', p.x + 8, p.y - 8);
      ctx.fillStyle = '#00e5ff';
    });

    if (this.points.length === 2) {
      ctx.beginPath();
      ctx.moveTo(this.points[0].x, this.points[0].y);
      ctx.lineTo(this.points[1].x, this.points[1].y);
      ctx.stroke();
    }
    ctx.restore();
  }
}
