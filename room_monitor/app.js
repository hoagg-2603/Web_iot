// app.js
import { fetchDeviceStates, controlDevice } from './js/api.js';
import { initDashboardChart, updateChart } from './js/chart.js';
import { setupSSEConnection } from './js/sse.js';
import { 
    LS_KEY_DEVICES, 
    setControlsDisabled, 
    updateSensorDisplay, 
    updateDeviceToggles, 
    updateDeviceToggle 
} from './js/ui.js';

let controlsEnabled = false;

// Hàm điều khiển logic điều khiển thiết bị
async function setupDeviceControls() {
    setControlsDisabled(true); 

    try {
        const raw = localStorage.getItem(LS_KEY_DEVICES);
        if (raw) updateDeviceToggles(JSON.parse(raw));
    } catch {}

    // Đồng bộ trạng thái mới nhất từ server
    const serverStates = await fetchDeviceStates();
    updateDeviceToggles(serverStates);
    
    // Gán sự kiện click
    const toggleSwitches = document.querySelectorAll('.toggle-switch');
    toggleSwitches.forEach((toggle, index) => {
        toggle.addEventListener('click', function() {
            if (!controlsEnabled || this.classList.contains('disabled') || this.classList.contains('loading')) {
                return;
            }
            
            const deviceMap = ['led', 'fan', 'spe'];
            const device = deviceMap[index];
            if (!device) return;

            // Quyết định hành động dựa trên trạng thái HIỆN TẠI
            const action = this.classList.contains('active') ? 'off' : 'on';

            // Thêm class 'loading'
            this.classList.add('loading');
            
            // Gọi API
            controlDevice(device, action).catch((error) => {
                console.error('Control device failed (API level):', error);
                // Nếu API lỗi, server sẽ không gửi SSE,
                // nhưng ta nên gỡ loading để người dùng thử lại
                this.classList.remove('loading');
            });
        });
    });
}

// Hàm khởi tạo Dashboard
async function initializeDashboard() {
    await initDashboardChart();
    
    setupSSEConnection({
        onMqttStatus: (isConnected) => {
            controlsEnabled = isConnected;
            setControlsDisabled(!isConnected);
        },
        onDeviceUpdate: (device, state) => {
            updateDeviceToggle(device, state);
        },
        onInitialState: (states) => {
            updateDeviceToggles(states);
        },
        onSensorData: (sensorData) => {
            updateSensorDisplay(sensorData);
            updateChart(sensorData);
        }
    });

    await setupDeviceControls();
}

// Chạy khởi tạo
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('sensor-chart')) {
        initializeDashboard();
    }
});