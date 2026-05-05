// autotracker.js — 속도 예측 + NCC(정규화 교차상관) 기반 템플릿 매칭

export class AutoTracker {
  constructor({ stepCoarse = 3 } = {}) {
    this.stepCoarse = stepCoarse;

    // 템플릿
    this.template = null;
    this.thW = 0;
    this.thH = 0;

    // 추적 상태
    this.lastPos  = null;   // { x, y }
    this.velocity = { vx: 0, vy: 0 };
    this.box      = null;
    this.seeded   = false;

    // NCC 저신뢰도 임계값 (0~1, 이 값 미만이면 저신뢰)
    this.NCC_LOW_THRESHOLD = 0.45;
  }

  // ── 박스 드래그로 시드 설정 ──────────────────────────
  seedFromBox(canvas, bx, by, bw, bh, crop = 1.0) {
    const shrink = (1 - crop) / 2;
    bx = bx + bw * shrink;
    by = by + bh * shrink;
    bw = bw * crop;
    bh = bh * crop;
    const cx = bx + bw / 2;
    const cy = by + bh / 2;
    this.thW = Math.max(10, Math.ceil(bw / 2));
    this.thH = Math.max(10, Math.ceil(bh / 2));
    this.box      = { x: bx, y: by, w: bw, h: bh };
    this.lastPos  = { x: cx, y: cy };
    this.velocity = { vx: 0, vy: 0 };

    const { width: W, height: H } = canvas;
    const ctx = canvas.getContext('2d');
    this._buildTemplate(ctx.getImageData(0, 0, W, H), W, H, cx, cy);
    this.seeded = true;
  }

  _buildTemplate(imageData, W, H, cx, cy) {
    const { thW, thH } = this;
    this.template = new Float32Array(thW * 2 * thH * 2);
    for (let dy = -thH; dy < thH; dy++) {
      for (let dx = -thW; dx < thW; dx++) {
        const px = Math.round(cx) + dx, py = Math.round(cy) + dy;
        this.template[(dy + thH) * thW * 2 + (dx + thW)] =
          (px >= 0 && px < W && py >= 0 && py < H)
            ? this._gray(imageData.data, py * W + px) : 0;
      }
    }
  }

  // ── 단일 프레임 탐색 ─────────────────────────────────
  findInCanvas(canvas, interval = 1) {
    if (!this.seeded) throw new Error('seedFromBox() 먼저 호출하세요');
    const { width: W, height: H } = canvas;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, W, H);

    // 속도 기반 예측 위치
    const predX = this.lastPos.x + this.velocity.vx * interval;
    const predY = this.lastPos.y + this.velocity.vy * interval;

    // 동적 탐색 반경
    const searchR = Math.min(30 + interval * 15, 100);

    const result = this._matchTwoPhase(imageData, W, H, predX, predY, searchR);

    result.confidence    = Math.max(0, result.ncc);
    result.lowConfidence = result.ncc < this.NCC_LOW_THRESHOLD;

    // 화면 경계 근접 여부 (물체가 프레임 밖으로 나간 것으로 판단)
    const margin = 4;
    result.outOfBounds =
      result.x <= this.thW + margin || result.x >= W - this.thW - margin ||
      result.y <= this.thH + margin || result.y >= H - this.thH - margin;

    return result;
  }

  _matchTwoPhase(imageData, W, H, cx, cy, searchR) {
    const { thW, thH, stepCoarse: sc } = this;

    const x0 = Math.max(thW,     Math.round(cx - searchR));
    const x1 = Math.min(W-thW-1, Math.round(cx + searchR));
    const y0 = Math.max(thH,     Math.round(cy - searchR));
    const y1 = Math.min(H-thH-1, Math.round(cy + searchR));

    // 1단계: 거친 탐색 (NCC 최대값 탐색)
    let bestX = Math.round(cx), bestY = Math.round(cy), bestNCC = -Infinity;
    for (let y = y0; y <= y1; y += sc) {
      for (let x = x0; x <= x1; x += sc) {
        const ncc = this._ncc(imageData.data, W, x, y);
        if (ncc > bestNCC) { bestNCC = ncc; bestX = x; bestY = y; }
      }
    }

    // 2단계: ±sc 정밀 탐색
    const rx0 = Math.max(thW,     bestX - sc);
    const rx1 = Math.min(W-thW-1, bestX + sc);
    const ry0 = Math.max(thH,     bestY - sc);
    const ry1 = Math.min(H-thH-1, bestY + sc);
    for (let y = ry0; y <= ry1; y++) {
      for (let x = rx0; x <= rx1; x++) {
        const ncc = this._ncc(imageData.data, W, x, y);
        if (ncc > bestNCC) { bestNCC = ncc; bestX = x; bestY = y; }
      }
    }

    return { x: bestX, y: bestY, ncc: bestNCC };
  }

  // 정규화 교차상관 (NCC) — 밝기 변화에 강인함, 범위 -1~1
  _ncc(pixels, W, cx, cy) {
    const { thW, thH } = this;

    // 1패스: 평균 계산 (2픽셀 샘플링)
    let tSum = 0, sSum = 0, count = 0;
    for (let dy = -thH; dy < thH; dy += 2) {
      for (let dx = -thW; dx < thW; dx += 2) {
        tSum += this.template[(dy + thH) * thW * 2 + (dx + thW)];
        sSum += this._gray(pixels, (cy + dy) * W + (cx + dx));
        count++;
      }
    }
    const tMean = tSum / count, sMean = sSum / count;

    // 2패스: NCC 계산
    let cross = 0, tNorm2 = 0, sNorm2 = 0;
    for (let dy = -thH; dy < thH; dy += 2) {
      for (let dx = -thW; dx < thW; dx += 2) {
        const t = this.template[(dy + thH) * thW * 2 + (dx + thW)] - tMean;
        const s = this._gray(pixels, (cy + dy) * W + (cx + dx)) - sMean;
        cross  += t * s;
        tNorm2 += t * t;
        sNorm2 += s * s;
      }
    }

    const denom = Math.sqrt(tNorm2 * sNorm2);
    if (denom < 1e-6) return 0;
    return cross / denom;
  }

  _gray(pixels, idx) {
    const i = idx * 4;
    return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
  }

  // 속도 업데이트
  updateVelocity(newX, newY) {
    this.velocity.vx = (newX - this.lastPos.x) * 0.6;
    this.velocity.vy = (newY - this.lastPos.y) * 0.6;
  }

  // 적응형 템플릿 업데이트 — 고신뢰도일 때만 반영
  updateTemplate(canvas, x, y, confidence = 1) {
    const alpha = 0.06 * Math.min(confidence, 1);
    if (alpha < 0.01) return;

    const { width: W, height: H } = canvas;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, W, H);
    const { thW, thH } = this;

    for (let dy = -thH; dy < thH; dy++) {
      for (let dx = -thW; dx < thW; dx++) {
        const px = Math.round(x) + dx, py = Math.round(y) + dy;
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        const tIdx = (dy + thH) * thW * 2 + (dx + thW);
        this.template[tIdx] =
          (1 - alpha) * this.template[tIdx] +
          alpha * this._gray(imageData.data, py * W + px);
      }
    }
  }

  reset() {
    this.template = null;
    this.lastPos  = null;
    this.velocity = { vx: 0, vy: 0 };
    this.box      = null;
    this.seeded   = false;
  }
}
