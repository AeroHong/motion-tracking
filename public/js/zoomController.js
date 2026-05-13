// zoomController.js — 캔버스 핀치줌 / 마우스휠 줌 / 두 손가락 패닝

export class ZoomController {
  constructor(canvas, { onDown, onMove, onUp, onZoom } = {}) {
    this.canvas    = canvas;
    this.scale     = 1;
    this.tx        = 0;
    this.ty        = 0;
    this._d0       = null;   // 직전 핀치 거리
    this._m0       = null;   // 직전 핀치 중점
    this._pinching = false;
    this._onDown   = onDown;
    this._onMove   = onMove;
    this._onUp     = onUp;
    this._onZoom   = onZoom;
    this._bind();
  }

  reset() {
    this.scale = 1; this.tx = 0; this.ty = 0;
    this._apply();
  }

  pan(dx, dy) {
    if (this.scale <= 1) return;
    this.tx += dx;
    this.ty += dy;
    this._apply();
  }

  // ── 내부 ──────────────────────────────────────────────
  _apply() {
    const c = this.canvas;
    c.style.transformOrigin = '0 0';
    c.style.transform = (this.scale === 1 && this.tx === 0 && this.ty === 0)
      ? '' : `translate(${this.tx}px,${this.ty}px) scale(${this.scale})`;
    this._onZoom?.(this.scale);
  }

  _zoomAt(newScale, pivotX, pivotY) {
    newScale = Math.max(1, Math.min(8, newScale));
    if (newScale === this.scale) return;
    const rect = this.canvas.getBoundingClientRect();
    const r    = newScale / this.scale;
    this.tx   += (pivotX - rect.left) * (1 - r);
    this.ty   += (pivotY - rect.top)  * (1 - r);
    this.scale = newScale;
    if (newScale <= 1.005) { this.scale = 1; this.tx = 0; this.ty = 0; }
    this._apply();
  }

  _bind() {
    const c = this.canvas;

    // ── 터치 (모바일/태블릿) ───────────────────────────
    c.addEventListener('touchstart', e => {
      e.preventDefault();
      if (e.touches.length >= 2) {
        this._pinching = true;
        this._d0 = _dist(e.touches);
        this._m0 = _mid(e.touches);
        return;
      }
      if (!this._pinching && e.touches.length === 1) {
        const t = e.touches[0];
        this._onDown?.({ currentTarget: c, clientX: t.clientX, clientY: t.clientY });
      }
    }, { passive: false });

    c.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length >= 2 && this._d0 !== null) {
        const d    = _dist(e.touches);
        const m    = _mid(e.touches);
        const rect = c.getBoundingClientRect();
        const r    = d / this._d0;
        const ns   = Math.max(1, Math.min(8, this.scale * r));
        const rv   = ns / this.scale;

        // 핀치 중점 기준 줌 + 중점 이동에 따른 패닝
        this.tx   += (m.x - rect.left) * (1 - rv) + (m.x - this._m0.x);
        this.ty   += (m.y - rect.top)  * (1 - rv) + (m.y - this._m0.y);
        this.scale = ns;
        this._d0   = d;
        this._m0   = m;
        if (ns <= 1.005) { this.scale = 1; this.tx = 0; this.ty = 0; }
        this._apply();
        return;
      }
      if (!this._pinching && e.touches.length === 1) {
        const t = e.touches[0];
        this._onMove?.({ currentTarget: c, clientX: t.clientX, clientY: t.clientY });
      }
    }, { passive: false });

    c.addEventListener('touchend', e => {
      e.preventDefault();
      const remaining = e.touches.length;
      if (remaining < 2) {
        this._d0 = null; this._m0 = null;
        if (remaining === 0) {
          const wasPinching = this._pinching;
          this._pinching = false;
          if (!wasPinching) {
            const t = e.changedTouches[0];
            this._onUp?.({ currentTarget: c, clientX: t.clientX, clientY: t.clientY });
          }
          // wasPinching=true: 핀치 종료 → onUp 호출 안 함
        }
        // remaining=1: 핀치 중 손가락 하나 뗌 → 무시
      }
    }, { passive: false });

    // ── 마우스 휠 (데스크탑/크롬북) ───────────────────
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      this._zoomAt(this.scale * factor, e.clientX, e.clientY);
    }, { passive: false });
  }
}

function _dist(t) {
  return Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY);
}
function _mid(t) {
  return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
}
