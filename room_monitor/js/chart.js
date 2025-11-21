// js/chart.js
import { loadInitialSensorData } from './api.js';

let sensorChart = null;
const MAX_POINTS = 20;
const LS_KEY_CHART = 'room_monitor_chart_cache_v1';

function parseTimestamp(ts) {
    // (Hàm parseTimestamp của bạn ở đây... )
    if (ts === null || ts === undefined) return null;
    if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts;
    if (typeof ts === 'number') {
        const ms = ts < 1e12 ? ts * 1000 : ts;
        const d = new Date(ms);
        return isNaN(d.getTime()) ? null : d;
    }
    if (typeof ts === 'string') {
        const num = Number(ts);
        if (!Number.isNaN(num)) return parseTimestamp(num);
        const isoLike = ts.includes(' ') && !ts.includes('T') ? ts.replace(' ', 'T') : ts;
        const d = new Date(isoLike);
        return isNaN(d.getTime()) ? null : d;
    }
    return null;
}

function loadChartCache() {
    try {
        const raw = localStorage.getItem(LS_KEY_CHART);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        return (obj && Array.isArray(obj.labels)) ? obj : null;
    } catch { return null; }
}

function saveChartCache() {
    try {
        if (!sensorChart) return;
        const payload = {
            labels: sensorChart.data.labels,
            temperature: sensorChart.data.datasets[0].data,
            humidity: sensorChart.data.datasets[1].data,
            light: sensorChart.data.datasets[2].data,
            savedAt: Date.now()
        };
        localStorage.setItem(LS_KEY_CHART, JSON.stringify(payload));
    } catch {}
}

const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false } },
    scales: {
        x: { grid: { display: true, color: '#e0e0e0', lineWidth: 1 }, ticks: { color: '#666', font: { size: 12 } } },
        y: { type: 'linear', position: 'left', min: 20, max: 35, grid: { display: true, color: '#e0e0e0', lineWidth: 1 }, ticks: { color: '#666', font: { size: 12 }, callback: v => v + '°C', stepSize: 1 } },
        y1:{ type: 'linear', position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: { color: '#666', font:{ size:12 }, callback: v => v + '%' } },
        y2:{ type: 'linear', display: false, min: 0, max: 400 }
    }
};

function createChart(ctx, chartData) {
    sensorChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: chartData.labels,
            datasets: [
                // XÓA dataset Temperature và Humidity cũ
                { 
                    label: 'Light (lux)', 
                    data: chartData.light, 
                    borderColor: '#FCF013', 
                    backgroundColor: 'rgba(252,240,19,0.2)', // Tăng độ đậm nền chút
                    tension: 0.4, 
                    pointRadius: 4, 
                    pointBackgroundColor: '#FCF013', 
                    pointBorderColor: '#333',
                    fill: true, // Bật fill cho đẹp vì chỉ còn 1 biểu đồ
                    yAxisID: 'y' 
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { grid: { display: false } }, // Ẩn lưới dọc cho thoáng
                y: { 
                    type: 'linear', 
                    position: 'left', 
                    min: 0, 
                    max: 100 // Vì random 0-100
                }
                // Xóa y1, y2 không cần thiết nữa
            }
        }
    });
}

export async function initDashboardChart() {
    const ctx = document.getElementById('sensor-chart');
    if (!ctx) return;

    const cached = loadChartCache();
    if (cached) {
        createChart(ctx, cached);
    } else {
        const initialData = await loadInitialSensorData();
        const dataToUse = (initialData || []).slice(-MAX_POINTS);
        const chartData = {
            temperature: dataToUse.map(i => i.t),
            humidity: dataToUse.map(i => i.h),
            light: dataToUse.map(i => i.lux || i.lx || 0),
            labels: dataToUse.map(i => {
                const d = parseTimestamp(i.time_stamp) || new Date();
                return d.toLocaleTimeString('en-US', {hour12:false, hour:'2-digit', minute:'2-digit'});
            })
        };
        createChart(ctx, chartData);
    }
}

export function updateChart(newData) {
    if (!sensorChart) return;

    const timeLabel = (new Date()).toLocaleTimeString('en-US', {hour12: false, hour: '2-digit', minute: '2-digit'});
    sensorChart.data.labels.push(timeLabel);
    if (sensorChart.data.labels.length > MAX_POINTS) sensorChart.data.labels.shift();

    // Chỉ push dữ liệu Light
    const val = (newData.lx !== undefined) ? newData.lx : (newData.lux || 0);
    sensorChart.data.datasets[0].data.push(val);
    
    if (sensorChart.data.datasets[0].data.length > MAX_POINTS) {
        sensorChart.data.datasets[0].data.shift();
    }

    sensorChart.update('none');
}