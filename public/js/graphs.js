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

  // 자유낙하: y 이동거리 vs 시간
  renderFreeFall(canvasEl, data) {
    this._destroy('freeFall');
    const labels = data.map(d => d.tSec.toFixed(3));
    const yVals = data.map(d => d.relYCm);

    this.charts['freeFall'] = new Chart(canvasEl, {
      type: 'scatter',
      data: {
        datasets: [{
          label: '자유낙하 y(cm)',
          data: data.map(d => ({ x: d.tSec, y: d.relYCm })),
          borderColor: '#ff5722',
          backgroundColor: 'rgba(255,87,34,0.7)',
          pointRadius: 5,
          showLine: true,
          borderWidth: 1.5,
        }]
      },
      options: {
        ...this._baseOptions('시간 (s)', 'y 이동거리 (cm)'),
        plugins: {
          ...this._baseLegend(),
          title: { display: true, text: '자유낙하: y-t 그래프', color: '#fff' }
        }
      }
    });
  }

  // 수평투사 x: x 이동거리 vs 시간 (등속)
  renderProjectileX(canvasEl, data) {
    this._destroy('projX');
    this.charts['projX'] = new Chart(canvasEl, {
      type: 'scatter',
      data: {
        datasets: [{
          label: '수평투사 x(cm)',
          data: data.map(d => ({ x: d.tSec, y: d.relXCm })),
          borderColor: '#29b6f6',
          backgroundColor: 'rgba(41,182,246,0.7)',
          pointRadius: 5,
          showLine: true,
          borderWidth: 1.5,
        }]
      },
      options: {
        ...this._baseOptions('시간 (s)', 'x 이동거리 (cm)'),
        plugins: {
          ...this._baseLegend(),
          title: { display: true, text: '수평투사: x-t 그래프 (등속)', color: '#fff' }
        }
      }
    });
  }

  // 수평투사 y: y 이동거리 vs 시간 (자유낙하와 비교)
  renderProjectileY(canvasEl, freeFallData, projData) {
    this._destroy('projY');
    this.charts['projY'] = new Chart(canvasEl, {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: '수평투사 y(cm)',
            data: projData.map(d => ({ x: d.tSec, y: d.relYCm })),
            borderColor: '#66bb6a',
            backgroundColor: 'rgba(102,187,106,0.7)',
            pointRadius: 5,
            showLine: true,
            borderWidth: 1.5,
          },
          {
            label: '자유낙하 y(cm)',
            data: freeFallData.map(d => ({ x: d.tSec, y: d.relYCm })),
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
        ...this._baseOptions('시간 (s)', 'y 이동거리 (cm)'),
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
