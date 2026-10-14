// calibration.js — 두 점 클릭으로 px → cm 보정 (보정 없이도 px 단위로 동작)

export class Calibration {
  constructor() {
    this.points = [];
    this.scale  = null;
    this.realLengthCm = null;
  }

  reset() {
    this._labelRect = null;
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
    // 치수선 방식(drawDimension)으로 그렸다면 그 라벨 영역으로 판정
    if (this._labelRect) {
      const r = this._labelRect;
      return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    }
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

  /**
   * 치수선 방식 보정 표시 (자유 물체 운동). A–B 직선은 그대로 두고, 두 점에서 화면 위쪽으로
   * 보조선을 세운 뒤 그 끝을 잇는 치수선 가운데에 길이 라벨을 둔다.
   * @param {number} k 캔버스 px / 화면 px — 영상 해상도·확대와 관계없이 화면에서 같은 크기로 그린다
   */
  drawDimension(ctx, k = 1) {
    this._labelRect = null;
    if (this.points.length === 0) return;
    ctx.save();
    const COL = this.scale ? '#00e676' : '#00e5ff';

    if (this.points.length === 2) {
      const [A, B] = this.points;
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y);
      ctx.strokeStyle = COL; ctx.lineWidth = 1.5 * k; ctx.stroke();

      // AB에 수직이면서 화면 위쪽(-y)을 향하는 단위 벡터
      const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len;
      if (ny > 0 || (ny === 0 && nx > 0)) { nx = -nx; ny = -ny; }
      const ext = 28 * k;
      const A2 = { x: A.x + nx * ext, y: A.y + ny * ext };
      const B2 = { x: B.x + nx * ext, y: B.y + ny * ext };

      // 보조선 (점선)
      ctx.setLineDash([4 * k, 3 * k]);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1 * k;
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(A2.x + nx * 4 * k, A2.y + ny * 4 * k); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(B.x, B.y); ctx.lineTo(B2.x + nx * 4 * k, B2.y + ny * 4 * k); ctx.stroke();
      ctx.setLineDash([]);

      // 치수선 + 양끝 화살촉
      ctx.strokeStyle = COL; ctx.fillStyle = COL; ctx.lineWidth = 1.2 * k;
      ctx.beginPath(); ctx.moveTo(A2.x, A2.y); ctx.lineTo(B2.x, B2.y); ctx.stroke();
      const ux = dx / len, uy = dy / len, ah = 7 * k, aw = 3.5 * k;
      [[A2, 1], [B2, -1]].forEach(([P, d]) => {
        ctx.beginPath();
        ctx.moveTo(P.x, P.y);
        ctx.lineTo(P.x + d * ux * ah + nx * aw, P.y + d * uy * ah + ny * aw);
        ctx.lineTo(P.x + d * ux * ah - nx * aw, P.y + d * uy * ah - ny * aw);
        ctx.closePath(); ctx.fill();
      });

      // 가운데 라벨 (항상 수평으로 읽히게)
      const text = this.scale ? `${this.realLengthCm} cm` : '길이 입력';
      ctx.font = `bold ${12 * k}px sans-serif`;
      const tw = ctx.measureText(text).width;
      const pw = tw + 14 * k, ph = 20 * k;
      const cx = (A2.x + B2.x) / 2 + nx * 12 * k, cy = (A2.y + B2.y) / 2 + ny * 12 * k;
      const rx = cx - pw / 2, ry = cy - ph / 2;
      _roundRect(ctx, rx, ry, pw, ph, ph / 2);
      ctx.fillStyle = this.scale ? 'rgba(0,120,60,0.85)' : 'rgba(0,0,0,0.7)';
      ctx.fill();
      ctx.strokeStyle = COL; ctx.lineWidth = 1 * k; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, cx, cy + 0.5 * k);
      this._labelRect = { x: rx, y: ry, w: pw, h: ph };
    }

    // A / B 점 — 작은 점 + 십자선
    this.points.forEach((p, i) => {
      ctx.strokeStyle = COL; ctx.lineWidth = 1 * k;
      ctx.beginPath();
      ctx.moveTo(p.x - 9 * k, p.y); ctx.lineTo(p.x - 5 * k, p.y);
      ctx.moveTo(p.x + 5 * k, p.y); ctx.lineTo(p.x + 9 * k, p.y);
      ctx.moveTo(p.x, p.y - 9 * k); ctx.lineTo(p.x, p.y - 5 * k);
      ctx.moveTo(p.x, p.y + 5 * k); ctx.lineTo(p.x, p.y + 9 * k);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x, p.y, 3 * k, 0, Math.PI * 2);
      ctx.fillStyle = COL; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1 * k; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${11 * k}px sans-serif`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(i === 0 ? 'A' : 'B', p.x + 8 * k, p.y + 14 * k);
    });
    ctx.restore();
  }

  draw(ctx) {
    this._labelRect = null;
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
