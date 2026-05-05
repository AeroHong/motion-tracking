// ml-detector.js — TF.js + COCO-SSD 기반 물체 자동 감지 (레이지 로드)

let model   = null;
let loading = false;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload  = resolve;
    s.onerror = () => reject(new Error(`스크립트 로드 실패: ${src}`));
    document.head.appendChild(s);
  });
}

export async function detectObjects(canvas, onStatus) {
  if (loading) return [];
  loading = true;

  try {
    if (!window.cocoSsd) {
      onStatus('ML 라이브러리 다운로드 중... (첫 실행 시 약 5~10초)');
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.15.0/dist/tf.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
    }

    if (!model) {
      onStatus('물체 감지 모델 준비 중...');
      model = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
    }

    onStatus('물체 감지 중...');
    const predictions = await model.detect(canvas);
    return predictions; // [{bbox:[x,y,w,h], class, score}, ...]
  } finally {
    loading = false;
  }
}

// 감지 결과를 캔버스에 오버레이 그리기
const CLASS_COLORS = {
  'sports ball': '#ff5722',
  'person':      '#29b6f6',
  'bottle':      '#66bb6a',
  'cup':         '#ffa726',
};

export function drawDetections(ctx, detections) {
  detections.forEach(d => {
    const [x, y, w, h] = d.bbox;
    const color = CLASS_COLORS[d.class] ?? '#ce93d8';
    const label = `${d.class} ${Math.round(d.score * 100)}%`;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2.5;
    ctx.strokeRect(x, y, w, h);

    // 라벨 배경
    ctx.font = 'bold 14px sans-serif';
    const tw = ctx.measureText(label).width + 10;
    ctx.fillStyle = color;
    ctx.fillRect(x, y - 22, tw, 22);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 5, y - 5);

    // 모서리 핸들
    ctx.fillStyle = color;
    [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([px,py]) =>
      ctx.fillRect(px - 5, py - 5, 10, 10)
    );
    ctx.restore();
  });
}
