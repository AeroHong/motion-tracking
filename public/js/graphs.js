// graphs.js — Chart.js 그래프 렌더링

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

  // 자유낙하: y 이동거리 vs 시간 (첫 점 기준 0초)
  renderFreeFall(canvasEl, data, unit = 'cm') {
    this._destroy('freeFall');
    this.charts['freeFall'] = new Chart(canvasEl, {
      type: 'scatter',
      data: {
        datasets: [{
          label: `자유낙하 y(${unit})`,
          data: data.map(d => ({ x: d.relTSec, y: d.relYCm })),
          borderColor: '#ff5722',
          backgroundColor: 'rgba(255,87,34,0.7)',
          pointRadius: 5,
          showLine: true,
          borderWidth: 1.5,
        }]
      },
      options: {
        ...this._baseOptions('시간 (s)', `y 이동거리 (${unit})`),
        plugins: {
          ...this._baseLegend(),
          title: { display: true, text: '자유낙하: y-t 그래프', color: '#fff' }
        }
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
          borderColor: '#29b6f6',
          backgroundColor: 'rgba(41,182,246,0.7)',
          pointRadius: 5,
          showLine: true,
          borderWidth: 1.5,
        }]
      },
      options: {
        ...this._baseOptions('시간 (s)', `x 이동거리 (${unit})`),
        plugins: {
          ...this._baseLegend(),
          title: { display: true, text: '수평투사: x-t 그래프 (등속)', color: '#fff' }
        }
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
            borderColor: '#66bb6a',
            backgroundColor: 'rgba(102,187,106,0.7)',
            pointRadius: 5,
            showLine: true,
            borderWidth: 1.5,
          },
          {
            label: `자유낙하 y(${unit})`,
            data: freeFallData.map(d => ({ x: d.relTSec, y: d.relYCm })),
            borderColor: '#ff5722',
            backgroundColor: 'rgba(255,87,34,0.4)',
            pointRadius: 4,
            showLine: true,
            borderDash: [4, 4],
            borderWidth: 1.5,
          }
        ]
      },
      options: {
        ...this._baseOptions('시간 (s)', `y 이동거리 (${unit})`),
        plugins: {
          ...this._baseLegend(),
          title: { display: true, text: '수평투사 y vs 자유낙하 비교', color: '#fff' }
        }
      }
    });
  }

  _baseOptions(xLabel, yLabel) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          title: { display: true, text: xLabel, color: '#ccc' },
          ticks: { color: '#ccc' },
          grid: { color: 'rgba(255,255,255,0.1)' }
        },
        y: {
          title: { display: true, text: yLabel, color: '#ccc' },
          ticks: { color: '#ccc' },
          grid: { color: 'rgba(255,255,255,0.1)' }
        }
      }
    };
  }

  _baseLegend() {
    return {
      legend: { labels: { color: '#eee' } }
    };
  }
}
