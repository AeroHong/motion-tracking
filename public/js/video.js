// video.js — 영상 로드, fps 자동 측정, 프레임 탐색

export class VideoController {
  constructor(videoEl, canvasEl, onFpsDetected) {
    this.video = videoEl;
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.fps = 30; // 기본값
    this.frameInterval = 1 / 30;
    this.onFpsDetected = onFpsDetected;
    this._fpsDetected = false;
  }

  load(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      this.video.src = url;
      this.video.onloadedmetadata = () => {
        this.canvas.width = this.video.videoWidth;
        this.canvas.height = this.video.videoHeight;
        this._detectFps().then(() => resolve());
      };
      this.video.onerror = reject;
      this.video.load();
    });
  }

  // requestVideoFrameCallback 으로 실제 프레임 타이밍 측정
  _detectFps() {
    return new Promise(resolve => {
      if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
        // 미지원 브라우저 → 기본값 유지
        this.onFpsDetected(this.fps, false);
        resolve();
        return;
      }

      const timestamps = [];
      const SAMPLE = 10; // 10프레임 샘플

      const onFrame = (now, meta) => {
        timestamps.push(meta.mediaTime);
        if (timestamps.length < SAMPLE) {
          this.video.requestVideoFrameCallback(onFrame);
        } else {
          this.video.pause();
          this.video.currentTime = 0;

          const intervals = [];
          for (let i = 1; i < timestamps.length; i++) {
            intervals.push(timestamps[i] - timestamps[i - 1]);
          }
          const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
          const detectedFps = Math.round(1 / avgInterval);

          // 일반적인 fps 값으로 보정 (24/25/30/60)
          const standard = [24, 25, 30, 60];
          this.fps = standard.reduce((prev, curr) =>
            Math.abs(curr - detectedFps) < Math.abs(prev - detectedFps) ? curr : prev
          );
          this.frameInterval = 1 / this.fps;
          this._fpsDetected = true;
          this.onFpsDetected(this.fps, true);
          resolve();
        }
      };

      this.video.currentTime = 0;
      this.video.muted = true;
      this.video.play().then(() => {
        this.video.requestVideoFrameCallback(onFrame);
      }).catch(() => {
        this.onFpsDetected(this.fps, false);
        resolve();
      });
    });
  }

  setFps(fps) {
    this.fps = fps;
    this.frameInterval = 1 / fps;
  }

  drawCurrentFrame() {
    if (this.video.readyState >= 2) {
      this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    }
  }

  async seekToFrame(frameIndex) {
    const t = frameIndex * this.frameInterval;
    return this._seekTo(t);
  }

  async seekToTime(t) {
    return this._seekTo(t);
  }

  _seekTo(t) {
    return new Promise(resolve => {
      const clamped = Math.max(0, Math.min(t, this.video.duration || 0));
      if (Math.abs(this.video.currentTime - clamped) < 0.001) {
        this.drawCurrentFrame();
        resolve();
        return;
      }
      const onSeeked = () => {
        this.video.removeEventListener('seeked', onSeeked);
        this.drawCurrentFrame();
        resolve();
      };
      this.video.addEventListener('seeked', onSeeked);
      this.video.currentTime = clamped;
    });
  }

  get totalFrames() {
    if (!this.video.duration) return 0;
    return Math.floor(this.video.duration * this.fps);
  }

  get currentFrame() {
    return Math.round(this.video.currentTime * this.fps);
  }
}
