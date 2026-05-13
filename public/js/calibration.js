// calibration.js — 두 점 클릭으로 px → cm 보정 (보정 없이도 px 단위로 동작)

export class Calibration {
  constructor() {
    this.points = [];
    this.scale  = null;
    this.realLengthCm = null;
  }

  reset() {
    this.points = [];
    this.scale  = null;
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

  get buttonCenter() {
    if (this.points.length < 2) return null;
    return {
      x: (this.points[0].x + this.points[1].x) / 2,
      y: (this.points[0].y + this.points[1].y) / 2,
    };
  }

  // 버튼 영역 히트 테스트 (캔버스 좌표)
  isOnButton(x, y) {
    const bc = this.buttonCenter;
    if (!bc) return false;
    const hw = this._btnHalfW, hh = 16;
    return x >= bc.x - hw && x <= bc.x + hw &&
           y >= bc.y - hh && y <= bc.y + hh;
  }

  get _btnHalfW() { return this.scale ? 58 : 50; }

  setRealLength(cm) {
    const px = this.pixelDistance;
    if (!px || px === 0) return false;
    this.realLengthCm = cm;
    this.scale = cm / px;
    return true;
  }

  findPointNear(x, y, radius = 22) {
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      const dx = p.x - x, dy = p.y - y;
      if (Math.sqrt(dx * dx + dy * dy) <= radius) return i;
    }
    return -1;
  }

  movePoint(idx, x, y) {
    if (idx >= 0 && idx < this.points.length) {
      this.points[idx] = { x, y };
    }
  }

  toUnit(px) {
    if (px === null || px === undefined) return null;
    return this.scale ? px * this.scale : px;
  }

  toCm(px) { return this.toUnit(px); }

  get unit()         { return this.scale ? 'cm' : 'px'; }
  get isCalibrated() { return this.scale !== null; }

  draw(ctx) {
    if (this.points.length === 0) return;
    ctx.save();

    if (this.points.length === 2) {
      // 두 점 연결선
      ctx.beginPath();
      ctx.moveTo(this.points[0].x, this.points[0].y);
      ctx.lineTo(this.points[1].x, this.points[1].y);
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth   = 2;
      ctx.stroke();

      // 중간 버튼
      const bc   = this.buttonCenter;
      const hw   = this._btnHalfW;
      const hh   = 16;
      const r    = 7;
      const x0   = bc.x - hw, y0 = bc.y - hh, w = hw * 2, h = hh * 2;

      ctx.beginPath();
      _roundRect(ctx, x0, y0, w, h, r);
      ctx.fillStyle   = this.scale ? 'rgba(0,200,83,0.92)' : 'rgba(0,229,255,0.92)';
      ctx.fill();
      ctx.strokeStyle = this.scale ? '#00c853' : '#00b8d4';
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      ctx.fillStyle    = '#000';
      ctx.font         = 'bold 12px sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        this.scale ? `✓ ${this.realLengthCm}cm  ✏️` : '📏 길이 입력',
        bc.x, bc.y
      );
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'alphabetic';

      // 픽셀 거리 표시 (버튼 위)
      const pxDist = this.pixelDistance?.toFixed(1) ?? '-';
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font      = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${pxDist}px`, bc.x, y0 - 5);
      ctx.textAlign = 'left';
    }

    // A / B 점
    this.points.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,229,255,0.25)';
      ctx.lineWidth   = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fillStyle   = '#00e5ff';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      ctx.fillStyle = '#fff';
      ctx.font      = 'bold 13px sans-serif';
      ctx.fillText(i === 0 ? 'A' : 'B', p.x + 10, p.y - 10);
    });

    ctx.restore();
  }
}

function _roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}
