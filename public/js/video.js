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
        this._detectFps(file).then(() => resolve());
      };
      this.video.onerror = reject;
      this.video.load();
    });
  }

  _detectFps(file) {
    return new Promise(async resolve => {
      // 1순위: MP4/MOV 컨테이너 메타데이터 직접 파싱 (가장 정확, 재생 불필요)
      try {
        const fps = await _readFpsFromFile(file);
        this._applyFps(fps, true);
        resolve();
        return;
      } catch (_) {}

      // 2순위: requestVideoFrameCallback — 실제 프레임 타임스탬프 측정
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        try {
          await this._detectFpsByFrameCallback();
          resolve();
          return;
        } catch (_) {}
      }

      // 3순위: 시크 기반 감지
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

// MP4/MOV 컨테이너에서 fps 직접 파싱
// 최상위 박스를 헤더만 읽으며 순회 → moov 위치 파악 → moov만 읽어서 파싱
// (moov가 파일 끝에 있어도 전체를 읽지 않음)
async function _readFpsFromFile(file) {
  // 1단계: 최상위 박스 헤더를 하나씩 읽으며 moov 위치 탐색
  let offset = 0;
  let moovStart = -1;
  let moovSize = 0;

  while (offset + 8 <= file.size) {
    const headerBuf = await file.slice(offset, offset + 16).arrayBuffer();
    const hdv = new DataView(headerBuf);

    let size = hdv.getUint32(0, false);
    const type = String.fromCharCode(
      hdv.getUint8(4), hdv.getUint8(5), hdv.getUint8(6), hdv.getUint8(7)
    );

    if (size === 1) {
      // extended 64-bit size (상위 32비트는 무시 — 실용적 영상 크기에서 충분)
      size = hdv.getUint32(12, false);
    }
    if (size === 0) size = file.size - offset;
    if (size < 8) throw new Error('invalid box');

    if (type === 'moov') {
      moovStart = offset;
      moovSize  = size;
      break;
    }
    offset += size;
  }

  if (moovStart < 0) throw new Error('moov not found');

  // 2단계: moov 박스만 읽어서 파싱
  const buf = await file.slice(moovStart, moovStart + moovSize).arrayBuffer();
  const dv  = new DataView(buf);

  const u32 = off => dv.getUint32(off, false);
  const str = off => String.fromCharCode(
    dv.getUint8(off), dv.getUint8(off+1), dv.getUint8(off+2), dv.getUint8(off+3)
  );

  function findBox(start, end, type) {
    let off = start;
    const limit = Math.min(end, dv.byteLength);
    while (off + 8 <= limit) {
      let size = u32(off);
      const t   = str(off + 4);
      if (size === 0) size = limit - off;
      if (size < 8) break;
      const boxEnd = Math.min(off + size, limit);
      if (t === type) return { dataStart: off + 8, end: boxEnd };
      off += size;
    }
    return null;
  }

  // moov 박스 내부는 offset 8부터 시작 (박스 헤더 8바이트 제외)
  let trakOff = 8;
  while (trakOff < buf.byteLength) {
    const trak = findBox(trakOff, buf.byteLength, 'trak');
    if (!trak) break;
    trakOff = trak.end;

    const mdia = findBox(trak.dataStart, trak.end, 'mdia');
    if (!mdia) continue;

    const hdlr = findBox(mdia.dataStart, mdia.end, 'hdlr');
    if (!hdlr || str(hdlr.dataStart + 8) !== 'vide') continue;

    const mdhd = findBox(mdia.dataStart, mdia.end, 'mdhd');
    if (!mdhd) continue;
    const ver       = dv.getUint8(mdhd.dataStart);
    const timescale = ver === 1 ? u32(mdhd.dataStart + 20) : u32(mdhd.dataStart + 12);
    if (!timescale) continue;

    const minf = findBox(mdia.dataStart, mdia.end, 'minf');
    if (!minf) continue;
    const stbl = findBox(minf.dataStart, minf.end, 'stbl');
    if (!stbl) continue;
    const stts = findBox(stbl.dataStart, stbl.end, 'stts');
    if (!stts) continue;

    const entryCount  = u32(stts.dataStart + 4);
    if (!entryCount) continue;
    const sampleDelta = u32(stts.dataStart + 12);
    if (!sampleDelta) continue;

    return _nearestStdFps(timescale / sampleDelta);
  }

  throw new Error('video fps not found in moov');
}
