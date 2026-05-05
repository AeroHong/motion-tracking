// autotracker.js — 박스 드래그 기반 템플릿 매칭 자동 추적

export class AutoTracker {
  constructor({ searchRadius = 100, stepCoarse = 4 } = {}) {
    this.searchR    = searchRadius;
    this.stepCoarse = stepCoarse;
    this.template   = null;   // Float32Array (그레이스케일)
    this.thW        = 0;      // 템플릿 절반 너비
    this.thH        = 0;      // 템플릿 절반 높이
    this.lastPos    = null;   // { x, y } — 마지막 찾은 중심
    this.box        = null;   // { x, y, w, h } — 원본 선택 박스
    this.seeded     = false;
  }

  // ── 박스 드래그로 시드 설정 ──────────────────────────
  seedFromBox(canvas, bx, by, bw, bh) {
    const cx = bx + bw / 2;
    const cy = by + bh / 2;
    this.thW = Math.ceil(bw / 2);
    this.thH = Math.ceil(bh / 2);
    this.box = { x: bx, y: by, w: bw, h: bh };
    this.lastPos = { x: cx, y: cy };

    const { width: W, height: H } = canvas;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, W, H);
    this._buildTemplate(imageData, W, H, cx, cy);
    this.seeded = true;
  }

  _buildTemplate(imageData, W, H, cx, cy) {
    const thW = this.thW, thH = this.thH;
    const sizeX = thW * 2, sizeY = thH * 2;
    this.template = new Float32Array(sizeX * sizeY);

    for (let dy = -thH; dy < thH; dy++) {
      for (let dx = -thW; dx < thW; dx++) {
        const px = Math.round(cx) + dx;
        const py = Math.round(cy) + dy;
        this.template[(dy + thH) * sizeX + (dx + thW)] =
          (px >= 0 && px < W && py >= 0 && py < H)
            ? this._gray(imageData.data, py * W + px)
            : 0;
      }
    }
  }

  // ── 단일 프레임 탐색 ──────────────────────────────────
  findInCanvas(canvas) {
    if (!this.seeded) throw new Error('seedFromBox() 먼저 호출하세요');
    const { width: W, height: H } = canvas;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, W, H);
    return this._matchTwoPhase(imageData, W, H);
  }

  _matchTwoPhase(imageData, W, H) {
    const { x: cx, y: cy } = this.lastPos;
    const thW = this.thW, thH = this.thH;
    const sr = this.searchR, sc = this.stepCoarse;

    const x0 = Math.max(thW, Math.round(cx - sr));
    const x1 = Math.min(W - thW - 1, Math.round(cx + sr));
    const y0 = Math.max(thH, Math.round(cy - sr));
    const y1 = Math.min(H - thH - 1, Math.round(cy + sr));

    // 1단계: 거친 탐색
    let bestX = Math.round(cx), bestY = Math.round(cy), bestSSD = Infinity;
    for (let y = y0; y <= y1; y += sc) {
      for (let x = x0; x <= x1; x += sc) {
        const ssd = this._ssd(imageData.data, W, x, y);
        if (ssd < bestSSD) { bestSSD = ssd; bestX = x; bestY = y; }
      }
    }

    // 2단계: 정밀 탐색
    const rx0 = Math.max(thW, bestX - sc);
    const rx1 = Math.min(W - thW - 1, bestX + sc);
    const ry0 = Math.max(thH, bestY - sc);
    const ry1 = Math.min(H - thH - 1, bestY + sc);

    for (let y = ry0; y <= ry1; y++) {
      for (let x = rx0; x <= rx1; x++) {
        const ssd = this._ssd(imageData.data, W, x, y);
        if (ssd < bestSSD) { bestSSD = ssd; bestX = x; bestY = y; }
      }
    }

    return { x: bestX, y: bestY, ssd: bestSSD };
  }

  _ssd(pixels, W, cx, cy) {
    const thW = this.thW, thH = this.thH;
    const sizeX = thW * 2;
    let ssd = 0;
    // 2px 간격 샘플링으로 4배 속도
    for (let dy = -thH; dy < thH; dy += 2) {
      for (let dx = -thW; dx < thW; dx += 2) {
        const gray = this._gray(pixels, (cy + dy) * W + (cx + dx));
        const tmpl = this.template[(dy + thH) * sizeX + (dx + thW)];
        const diff = gray - tmpl;
        ssd += diff * diff;
      }
    }
    return ssd;
  }

  _gray(pixels, idx) {
    const i = idx * 4;
    return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
  }

  // 적응형 템플릿 업데이트 (드리프트 방지, α=0.12)
  updateTemplate(canvas, x, y, alpha = 0.12) {
    const { width: W, height: H } = canvas;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, W, H);
    const thW = this.thW, thH = this.thH;
    const sizeX = thW * 2;

    for (let dy = -thH; dy < thH; dy++) {
      for (let dx = -thW; dx < thW; dx++) {
        const px = Math.round(x) + dx;
        const py = Math.round(y) + dy;
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        const newGray = this._gray(imageData.data, py * W + px);
        const tIdx = (dy + thH) * sizeX + (dx + thW);
        this.template[tIdx] = (1 - alpha) * this.template[tIdx] + alpha * newGray;
      }
    }
  }

  reset() {
    this.template = null;
    this.lastPos  = null;
    this.box      = null;
    this.seeded   = false;
  }
}
