// autotracker.js — 템플릿 매칭 기반 자동 물체 추적

export class AutoTracker {
  constructor({ templateHalf = 22, searchRadius = 90, stepCoarse = 4 } = {}) {
    this.th          = templateHalf;  // 템플릿 절반 크기 (px)
    this.searchR     = searchRadius;  // 탐색 반경 (px)
    this.stepCoarse  = stepCoarse;    // 1차 탐색 간격 (빠른 스캔)
    this.template    = null;          // Float32Array (그레이스케일)
    this.lastPos     = null;          // { x, y }
    this.seeded      = false;
  }

  // ── 시드: 첫 프레임 클릭 시 호출 ─────────────────────
  seed(canvas, cx, cy) {
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    this._extractTemplate(imageData, canvas.width, canvas.height, cx, cy);
    this.lastPos = { x: cx, y: cy };
    this.seeded = true;
  }

  _extractTemplate(imageData, W, H, cx, cy) {
    const th   = this.th;
    const size = th * 2;
    this.template = new Float32Array(size * size);

    for (let dy = -th; dy < th; dy++) {
      for (let dx = -th; dx < th; dx++) {
        const px = Math.round(cx) + dx;
        const py = Math.round(cy) + dy;
        this.template[(dy + th) * size + (dx + th)] =
          (px >= 0 && px < W && py >= 0 && py < H)
            ? this._gray(imageData.data, py * W + px)
            : 0;
      }
    }
  }

  // ── 단일 프레임 탐색 ──────────────────────────────────
  findInCanvas(canvas) {
    if (!this.seeded) throw new Error('seed() 먼저 호출하세요');
    const ctx = canvas.getContext('2d');
    const { width: W, height: H } = canvas;
    const imageData = ctx.getImageData(0, 0, W, H);
    return this._matchTwoPhase(imageData, W, H);
  }

  _matchTwoPhase(imageData, W, H) {
    const { x: cx, y: cy } = this.lastPos;
    const th = this.th;
    const sr = this.searchR;
    const sc = this.stepCoarse;

    const x0 = Math.max(th, Math.round(cx - sr));
    const x1 = Math.min(W - th - 1, Math.round(cx + sr));
    const y0 = Math.max(th, Math.round(cy - sr));
    const y1 = Math.min(H - th - 1, Math.round(cy + sr));

    // 1단계: 거친 탐색 (stepCoarse 간격)
    let bestX = cx, bestY = cy, bestSSD = Infinity;
    for (let y = y0; y <= y1; y += sc) {
      for (let x = x0; x <= x1; x += sc) {
        const ssd = this._ssd(imageData.data, W, x, y);
        if (ssd < bestSSD) { bestSSD = ssd; bestX = x; bestY = y; }
      }
    }

    // 2단계: 정밀 탐색 (±stepCoarse 범위)
    const rx0 = Math.max(th, bestX - sc);
    const rx1 = Math.min(W - th - 1, bestX + sc);
    const ry0 = Math.max(th, bestY - sc);
    const ry1 = Math.min(H - th - 1, bestY + sc);

    for (let y = ry0; y <= ry1; y++) {
      for (let x = rx0; x <= rx1; x++) {
        const ssd = this._ssd(imageData.data, W, x, y);
        if (ssd < bestSSD) { bestSSD = ssd; bestX = x; bestY = y; }
      }
    }

    return { x: bestX, y: bestY, ssd: bestSSD };
  }

  // 후보 위치 (x,y) 에 대한 SSD 계산
  _ssd(pixels, W, cx, cy) {
    const th   = this.th;
    const size = th * 2;
    let ssd    = 0;

    // 픽셀 2칸 간격으로 샘플링 → 4배 속도
    for (let dy = -th; dy < th; dy += 2) {
      for (let dx = -th; dx < th; dx += 2) {
        const gray = this._gray(pixels, (cy + dy) * W + (cx + dx));
        const tmpl = this.template[(dy + th) * size + (dx + th)];
        const diff = gray - tmpl;
        ssd += diff * diff;
      }
    }
    return ssd;
  }

  // 그레이스케일 변환 (픽셀 인덱스 기준)
  _gray(pixels, idx) {
    const i = idx * 4;
    return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
  }

  // 추적 후 템플릿 점진적 업데이트 (드리프트 방지용, α=0.15)
  updateTemplate(canvas, x, y, alpha = 0.15) {
    const ctx = canvas.getContext('2d');
    const { width: W, height: H } = canvas;
    const imageData = ctx.getImageData(0, 0, W, H);
    const th   = this.th;
    const size = th * 2;

    for (let dy = -th; dy < th; dy++) {
      for (let dx = -th; dx < th; dx++) {
        const px = Math.round(x) + dx;
        const py = Math.round(y) + dy;
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        const newGray = this._gray(imageData.data, py * W + px);
        const tIdx    = (dy + th) * size + (dx + th);
        this.template[tIdx] = (1 - alpha) * this.template[tIdx] + alpha * newGray;
      }
    }
  }

  reset() {
    this.template = null;
    this.lastPos  = null;
    this.seeded   = false;
  }
}
