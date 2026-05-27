// video.js — 영상 로드, fps 자동 측정, 프레임 탐색

export class VideoController {
  constructor(videoEl, canvasEl, onFpsDetected) {
    this.video = videoEl;
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.fps = 30;
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

  _detectFps() {
    return new Promise(async resolve => {
      // 1순위: requestVideoFrameCallback — 실제 프레임 타임스탬프 측정 (가장 정확)
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        try {
          await this._detectFpsByFrameCallback();
          resolve();
          return;
        } catch (_) {}
      }

      // 2순위: 시크 기반 감지 (rVFC 미지원 환경 fallback)
      try {
        const fps = await this._detectFpsBySeeking();
        this._applyFps(fps, true);
        this.video.currentTime = 0;
        resolve();
        return;
      } catch (_) {}

      // 최종 fallback: 기본값 유지
      this.onFpsDetected(this.fps, false);
      resolve();
    });
  }

  _detectFpsByFrameCallback() {
    return new Promise((resolve, reject) => {
      const timestamps = [];
      const SAMPLE = 20;
      const onFrame = (now, meta) => {
        timestamps.push(meta.mediaTime);
        if (timestamps.length < SAMPLE) {
          this.video.requestVideoFrameCallback(onFrame);
        } else {
          this.video.pause();
          this.video.currentTime = 0;
          const intervals = [];
          for (let i = 1; i < timestamps.length; i++)
            intervals.push(timestamps[i] - timestamps[i - 1]);
          const avg = intervals.reduce((a, b) => a + b) / intervals.length;
          if (avg <= 0 || avg > 1) { reject(new Error('bad intervals')); return; }
          const fps = _nearestStdFps(1 / avg);
          this._applyFps(fps, true);
          resolve();
        }
      };

      this.video.currentTime = 0;
      this.video.muted = true;
      this.video.play().then(() => {
        this.video.requestVideoFrameCallback(onFrame);
      }).catch(reject);
    });
  }

  // 시크를 통해 실제 프레임 간격을 측정하는 fps 감지
  // 각 후보 fps마다 1.1 프레임 길이만큼 시크 → 실제 착지점으로 fps 판별
  async _detectFpsBySeeking() {
    const duration = this.video.duration;
    if (!duration || duration < 0.3) throw new Error('too short');

    const startT = Math.min(0.3, duration * 0.3);
    await this._seekTo(startT);
    const t0 = this.video.currentTime;

    // NTSC 계열(29.97, 59.94, 23.976) 포함
    for (const fps of [240, 120, 59.94, 60, 29.97, 30, 25, 23.976, 24]) {
      const step = 1.1 / fps;
      await this._seekTo(t0 + step);
      const t1 = this.video.currentTime;

      const moved = t1 - t0;
      const expected = 1 / fps;
      if (moved > 0.0001 && Math.abs(moved - expected) < 0.002) {
        return fps;
      }
    }
    throw new Error('detection failed');
  }

  _applyFps(detectedFps, auto) {
    const fps = Math.min(detectedFps, 60);
    this.fps = fps;
    this.frameInterval = 1 / fps;
    this._fpsDetected = true;
    this.onFpsDetected(fps, auto);
  }

  setFps(fps) {
    this.fps = Math.min(fps, 60);
    this.frameInterval = 1 / this.fps;
  }

  drawCurrentFrame() {
    if (this.video.readyState >= 2) {
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    }
  }

  async seekToFrame(frameIndex) {
    return this._seekTo(frameIndex * this.frameInterval);
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

function _nearestStdFps(detected) {
  const standard = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120, 240];
  return standard.reduce((p, c) =>
    Math.abs(c - detected) < Math.abs(p - detected) ? c : p
  );
}
