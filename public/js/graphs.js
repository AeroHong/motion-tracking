// graphs.js — Chart.js 그래프 렌더링 (결과 페이지 = 항상 라이트 배경)

const AXIS  = { color: '#444' };
const GRID  = { color: 'rgba(0,0,0,0.07)' };
const TICK  = { color: '#555' };
const TITLE_COLOR = '#1a1a2e';
const LEGEND_COLOR = '#333';

export class GraphRenderer {
  constructor() {
    this.charts = {};
  }

  _destroy(id) {
    if (this.charts[id]) {
      this.charts[id].destroy();
      delete this.charts[id];
    }
  }

  // 자유낙하: y 이동거리 vs 시간
  renderFreeFall(canvasEl, data, unit = 'cm') {
    this._destroy('freeFall');
    this.charts['freeFall'] = new Chart(canvasEl, {
      type: 'scatter',
      data: {
        datasets: [{
          label: `자유낙하 y(${unit})`,
          data: data.map(d => ({ x: d.relTSec, y: d.relYCm })),
          borderColor: '#e53935',
          backgroundColor: 'rgba(229,57,53,0.65)',
          pointRadius: 5, showLine: true, borderWidth: 1.5,
        }]
      },
      options: {
        ...this._base('시간 (s)', `y 이동거리 (${unit})`),
        plugins: { ...this._legend(), title: { display: true, text: '자유낙하: y-t 그래프', color: TITLE_COLOR } }
      }
    });
  }

  renderProjectileX(canvasEl, data, unit = 'cm') {
    this._destroy('projX');
    this.charts['projX'] = new Chart(canvasEl, {
      type: 'scatter',
      data: {
        datasets: [{
          label: `수평투사 x(${unit})`,
          data: data.map(d => ({ x: d.relTSec, y: d.relXCm })),
          borderColor: '#1565c0',
          backgroundColor: 'rgba(21,101,192,0.65)',
          pointRadius: 5, showLine: true, borderWidth: 1.5,
        }]
      },
      options: {
        ...this._base('시간 (s)', `x 이동거리 (${unit})`),
        plugins: { ...this._legend(), title: { display: true, text: '수평투사: x-t 그래프 (등속)', color: TITLE_COLOR } }
      }
    });
  }

  renderProjectileY(canvasEl, freeFallData, projData, unit = 'cm') {
    this._destroy('projY');
    this.charts['projY'] = new Chart(canvasEl, {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: `수평투사 y(${unit})`,
            data: projData.map(d => ({ x: d.relTSec, y: d.relYCm })),
            borderColor: '#2e7d32',
            backgroundColor: 'rgba(46,125,50,0.65)',
            pointRadius: 5, showLine: true, borderWidth: 1.5,
          },
          {
            label: `자유낙하 y(${unit})`,
            data: freeFallData.map(d => ({ x: d.relTSec, y: d.relYCm })),
            borderColor: '#e53935',
            backgroundColor: 'rgba(229,57,53,0.3)',
            pointRadius: 4, showLine: true, borderDash: [4, 4], borderWidth: 1.5,
          }
        ]
      },
      options: {
        ...this._base('시간 (s)', `y 이동거리 (${unit})`),
        plugins: { ...this._legend(), title: { display: true, text: '수평투사 y vs 자유낙하 비교', color: TITLE_COLOR } }
      }
    });
  }

  _base(xLabel, yLabel) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { min: 0, title: { display: true, text: xLabel, ...AXIS }, ticks: TICK, grid: GRID },
        y: { min: 0, title: { display: true, text: yLabel, ...AXIS }, ticks: TICK, grid: GRID }
      }
    };
  }

  _freeBase(xLabel, yLabel, extraY = {}) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { min: 0,   title: { display: true, text: xLabel, ...AXIS }, ticks: TICK, grid: GRID },
        y: { ...extraY, title: { display: true, text: yLabel, ...AXIS }, ticks: TICK, grid: GRID }
      }
    };
  }

  _legend() { return { legend: { labels: { color: LEGEND_COLOR } } }; }

  // ── 자유 물체 운동 그래프 ──────────────────────────────────
  renderFreeXT(canvasEl, data, unit = 'cm', label = '물체') {
    this._destroy('freeXT');
    this.charts['freeXT'] = new Chart(canvasEl, {
      type: 'scatter',
      data: {
        datasets: [{
          label: `x (${unit})`,
          data: data.map(d => ({ x: d.relTSec, y: d.relXCm })),
          borderColor: '#1565c0', backgroundColor: 'rgba(21,101,192,0.65)',
          pointRadius: 5, showLine: true, borderWidth: 1.5,
        }]
      },
      options: {
        ...this._freeBase('시간 (s)', `x 위치 (${unit})`),
        plugins: { ...this._legend(), title: { display: true, text: `${label} — x-t 그래프`, color: TITLE_COLOR } }
      }
    });
  }

  renderFreeYT(canvasEl, data, unit = 'cm', label = '물체') {
    this._destroy('freeYT');
    this.charts['freeYT'] = new Chart(canvasEl, {
      type: 'scatter',
      data: {
        datasets: [{
          label: `y (${unit})`,
          data: data.map(d => ({ x: d.relTSec, y: d.relYCm })),
          borderColor: '#c62828', backgroundColor: 'rgba(198,40,40,0.65)',
          pointRadius: 5, showLine: true, borderWidth: 1.5,
        }]
      },
      options: {
        ...this._freeBase('시간 (s)', `y 위치 (${unit})`),
        plugins: { ...this._legend(), title: { display: true, text: `${label} — y-t 그래프`, color: TITLE_COLOR } }
      }
    });
  }

  // x-y 궤적: reverse=true로 화면과 동일 방향(↓ 양수)
  renderFreeXY(canvasEl, data, unit = 'cm', label = '물체') {
    this._destroy('freeXY');
    this.charts['freeXY'] = new Chart(canvasEl, {
      type: 'scatter',
      data: {
        datasets: [{
          label: '궤적',
          data: data.map(d => ({ x: d.relXCm, y: d.relYCm })),
          borderColor: '#6a1b9a', backgroundColor: 'rgba(106,27,154,0.65)',
          pointRadius: 5, showLine: true, borderWidth: 1.5,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { title: { display: true, text: `x (${unit})`, ...AXIS }, ticks: TICK, grid: GRID },
          y: { reverse: true, title: { display: true, text: `y (${unit}, ↓+)`, ...AXIS }, ticks: TICK, grid: GRID }
        },
        plugins: { ...this._legend(), title: { display: true, text: `${label} — 궤적 (x-y)`, color: TITLE_COLOR } }
      }
    });
  }
}
