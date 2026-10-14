// loupe.js — 조준경 확대(루페): 점을 찍거나 옮기는 동안 손가락 근처를 확대해 보여준다
//   원본 영상 프레임(오버레이 없음)을 확대해 그리고, 가운데 십자선과 대상 점을 표시한다.
//   손가락에 가리지 않도록 포인터의 왼쪽 위에 띄우고, 화면 가장자리에서는 반대쪽으로 뒤집는다.

const SIZE   = 140;   // 화면 px (지름)
const ZOOM   = 4;     // 화면 기준 최대 확대 배율
const MIN_ZOOM = 1.25;
const MAX_PX_PER_SRC = 6;   // 루페에서 영상 1px이 차지할 최대 화면 px — 영상을 이미 확대했으면 루페 배율을 줄여 뭉개짐 방지
const OFFSET = 110;   // 포인터와 루페 중심 사이 거리 (화면 px)

export class Loupe {
  /**
   * @param {HTMLCanvasElement} target  영상을 그리는 캔버스 (좌표 기준)
   * @param {HTMLVideoElement}  video   확대에 쓸 원본 프레임
   */
  constructor(target, video) {
    this.target = target;
    this.video  = video;
    const dpr   = Math.min(window.devicePixelRatio || 1, 2);
    const c     = document.createElement('canvas');
    c.width = c.height = Math.round(SIZE * dpr);
    c.className = 'loupe-canvas hidden';
    c.style.width = c.style.height = SIZE + 'px';
    document.body.appendChild(c);
    this.canvas = c;
    this.ctx    = c.getContext('2d');
    this.dpr    = dpr;
  }

  /**
   * @param {number} cx, cy        확대 중심 (target 캔버스 px)
   * @param {number} clientX, clientY 포인터 화면 좌표
   * @param {{color?: string}} [marker] 가운데 표시할 점 색
   */
  show(cx, cy, clientX, clientY, marker = {}) {
    const rect = this.target.getBoundingClientRect();
    if (!rect.width) return;
    const k   = this.target.width / rect.width;      // 캔버스 px / 화면 px
    const zoom = Math.min(ZOOM, Math.max(MIN_ZOOM, MAX_PX_PER_SRC * k));
    this.lastZoom = zoom;
    const src = (SIZE / zoom) * k;                   // 원본에서 잘라 올 한 변 (캔버스 px)

    const ctx = this.ctx, S = this.canvas.width;
    ctx.save();
    ctx.clearRect(0, 0, S, S);
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
    // 영상 원본 좌표 = 캔버스 좌표 (캔버스 크기 = 영상 크기)
    if (this.video.readyState >= 2) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.video, cx - src / 2, cy - src / 2, src, src, 0, 0, S, S);
    }
    // 십자선
    const m = S / 2, g = 6 * this.dpr;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(0, m); ctx.lineTo(m - g, m); ctx.moveTo(m + g, m); ctx.lineTo(S, m);
    ctx.moveTo(m, 0); ctx.lineTo(m, m - g); ctx.moveTo(m, m + g); ctx.lineTo(m, S);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(m, m, 2.5 * this.dpr, 0, Math.PI * 2);
    ctx.fillStyle = marker.color || '#ff5722'; ctx.fill();
    ctx.restore();
    // 테두리
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 1.5 * this.dpr, 0, Math.PI * 2);
    ctx.strokeStyle = marker.color || '#ffeb3b'; ctx.lineWidth = 3 * this.dpr; ctx.stroke();

    // 위치: 기본은 포인터 왼쪽 위, 화면 밖으로 나가면 반대쪽
    const vw = window.innerWidth, vh = window.innerHeight, h = SIZE / 2;
    let x = clientX - OFFSET * 0.7, y = clientY - OFFSET;
    if (y - h < 4)       y = clientY + OFFSET;
    if (x - h < 4)       x = clientX + OFFSET * 0.7;
    if (x + h > vw - 4)  x = vw - 4 - h;
    if (y + h > vh - 4)  y = vh - 4 - h;
    this.canvas.style.left = (x - h) + 'px';
    this.canvas.style.top  = (y - h) + 'px';
    this.canvas.classList.remove('hidden');
  }

  hide() { this.canvas.classList.add('hidden'); }
}
