// Configuration
const API_BASE_URL = 'http://localhost:3000';
const SSE_URL = `${API_BASE_URL}/stream`;

// Global variables
let sensorChart = null;
let sseConnection = null;
let controlsEnabled = false; // disabled by default until MQTT/ESP is confirmed connected
let currentSensorData = { t: 0, h: 0, lx: 0 };
const MAX_POINTS = 20; // số điểm tối đa hiển thị trên biểu đồ
const LS_KEY_CHART = 'room_monitor_chart_cache_v1';
const LS_KEY_DEVICES = 'room_monitor_devices_cache_v1';

// ---- Date/Time helpers ----
function parseTimestamp(ts) {
    if (ts === null || ts === undefined) return null;
    if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts;
    if (typeof ts === 'number') {
        const ms = ts < 1e12 ? ts * 1000 : ts; // seconds -> ms if needed
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

function formatTimestamp(ts) {
    const d = parseTimestamp(ts);
    if (!d) return '-';
    const pad = (n) => String(n).padStart(2, '0');
    const dd = pad(d.getDate());
    const mm = pad(d.getMonth() + 1);
    const yyyy = d.getFullYear();
    const HH = pad(d.getHours());
    const MM = pad(d.getMinutes());
    const SS = pad(d.getSeconds());
    return `${dd}/${mm}/${yyyy} ${HH}:${MM}:${SS}`;
}

// Dashboard setup
async function initializeDashboard() {
    try {
        const cached = loadChartCache();
        if (cached) {
            initializeChartFromCache(cached);
        } else {
            const initialData = await loadInitialSensorData();
            initializeChart(initialData);
        }
        setupSSEConnection();
        await setupDeviceControls();
    } catch (error) {
        console.error('Error initializing dashboard:', error);
    }
}

async function loadInitialSensorData() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/sensors?limit=20`);
        if (!response.ok) throw new Error('Failed to fetch sensor data');
        const result = await response.json();
        return result.data || result;
    } catch (error) {
        console.error('Error loading initial sensor data:', error);
        return [];
    }
}

function initializeChart(initialData = []) {
    const ctx = document.getElementById('sensor-chart');
    if (!ctx) return;
    const dataToUse = (initialData || []).slice(-MAX_POINTS);
    // If no initial data, chart will hydrate via SSE
    const chartData = {
        temperature: dataToUse.map(i => i.t),
        humidity: dataToUse.map(i => i.h),
        light: dataToUse.map(i => i.lux || i.lx || 0),
        labels: dataToUse.map(i => {
            const d = parseTimestamp(i.time_stamp) || new Date();
            return d.toLocaleTimeString('en-US', {hour12:false, hour:'2-digit', minute:'2-digit'});
        })
    };
    sensorChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: chartData.labels,
            datasets: [
                { label: 'Temperature (°C)', data: chartData.temperature, borderColor: '#F81717', backgroundColor: 'rgba(248,23,23,0.1)', tension: 0.4, pointRadius: 6, pointBackgroundColor: '#F81717', pointBorderColor: '#ffffff', pointBorderWidth: 3, yAxisID: 'y' },
                { label: 'Humidity (%)', data: chartData.humidity, borderColor: '#2F69E6', backgroundColor: 'rgba(47,105,230,0.1)', tension: 0.4, pointRadius: 6, pointBackgroundColor: '#2F69E6', pointBorderColor: '#ffffff', pointBorderWidth: 3, yAxisID: 'y1' },
                { label: 'Light (lux)', data: chartData.light, borderColor: '#FCF013', backgroundColor: 'rgba(252,240,19,0.1)', tension: 0.4, pointRadius: 6, pointBackgroundColor: '#FCF013', pointBorderColor: '#333333', pointBorderWidth: 3, yAxisID: 'y2' }
            ]
        },
        options: {
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
        }
    });
}

function initializeChartFromCache(cache) {
    const ctx = document.getElementById('sensor-chart');
    if (!ctx) return;
    sensorChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: cache.labels || [],
            datasets: [
                { label: 'Temperature (°C)', data: cache.temperature || [], borderColor: '#F81717', backgroundColor: 'rgba(248,23,23,0.1)', tension: 0.4, pointRadius: 6, pointBackgroundColor: '#F81717', pointBorderColor: '#ffffff', pointBorderWidth: 3, yAxisID: 'y' },
                { label: 'Humidity (%)', data: cache.humidity || [], borderColor: '#2F69E6', backgroundColor: 'rgba(47,105,230,0.1)', tension: 0.4, pointRadius: 6, pointBackgroundColor: '#2F69E6', pointBorderColor: '#ffffff', pointBorderWidth: 3, yAxisID: 'y1' },
                { label: 'Light (lux)', data: cache.light || [], borderColor: '#FCF013', backgroundColor: 'rgba(252,240,19,0.1)', tension: 0.4, pointRadius: 6, pointBackgroundColor: '#FCF013', pointBorderColor: '#333333', pointBorderWidth: 3, yAxisID: 'y2' }
            ]
        },
        options: {
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
        }
    });
}

// Setup Server-Sent Events connection
function setupSSEConnection() {
    if (sseConnection) {
        sseConnection.close();
    }
    
    sseConnection = new EventSource(SSE_URL);
    
    sseConnection.onopen = function() {
        // SSE connection established; wait for mqtt status event to enable controls
    };
    
    sseConnection.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);
            
            // Handle MQTT status for enabling/disabling controls
            if (data.type === 'mqtt') {
                const isConnected = data.status === 'connected';
                controlsEnabled = isConnected;
                setControlsDisabled(!isConnected);
                return;
            }

            // Handle device state updates
            if (data.type === 'deviceState' || data.type === 'device_update') {
                updateDeviceToggle(data.device, data.state);
                return;
            }
            
            // Handle initial state
            if (data.type === 'initial_state') {
                updateDeviceToggles(data.states);
                return;
            }
            
            // Handle sensor data - support multiple formats
            if (data.type === 'sensor' || data.t !== undefined) {
                // Update current sensor data - try multiple field names
                currentSensorData = {
                    t: data.t || data.temp || data.temperature,
                    h: data.h || data.humi || data.humidity, 
                    lx: data.lx || data.lux || data.light || 0
                };
                
                // sensor data updated
                
                // Only update display if we have valid data
                if (currentSensorData.t !== undefined && currentSensorData.h !== undefined) {
                    updateSensorDisplay();
                    updateChart(currentSensorData);
                }
            }
            
        } catch (error) {
            // Swallow malformed SSE without flooding console
            // console.error('SSE parse error:', error);
        }
    };
    
    sseConnection.onerror = function(error) {
    // SSE connection error; will retry silently
        controlsEnabled = false;
        setControlsDisabled(true);
        // Try to reconnect after 5 seconds
        setTimeout(() => {
            setupSSEConnection();
        }, 5000);
    };
}

// Enable/disable device controls UI
function setControlsDisabled(disabled) {
    const toggles = document.querySelectorAll('.toggle-switch');
    toggles.forEach(t => {
        t.classList.toggle('disabled', disabled);
        t.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    });
}

// Update sensor display cards and values
function updateSensorDisplay() {
    // Validate sensor data before using
    if (!currentSensorData || typeof currentSensorData.t === 'undefined' || 
        typeof currentSensorData.h === 'undefined' || typeof currentSensorData.lx === 'undefined') {
        // Invalid sensor data; skip update
        return;
    }
    
    // Update temperature card
    const tempElement = document.getElementById('temperature-value');
    if (tempElement && typeof currentSensorData.t === 'number') {
        tempElement.textContent = currentSensorData.t.toFixed(1);
    }
    
    // Update humidity card  
    const humidityElement = document.getElementById('humidity-value');
    if (humidityElement && typeof currentSensorData.h === 'number') {
        humidityElement.textContent = currentSensorData.h.toFixed(1);
    }
    
    // Update light card
    const lightElement = document.getElementById('light-value');
    if (lightElement && typeof currentSensorData.lx === 'number') {
        lightElement.textContent = Math.round(currentSensorData.lx);
    }
    
    // Add visual feedback to cards
    animateSensorCard('temperature-card');
    animateSensorCard('humidity-card'); 
    animateSensorCard('light-card');
}

// Animate sensor card when updated
function animateSensorCard(cardId) {
    const card = document.getElementById(cardId);
    if (card) {
        card.style.transform = 'scale(1.02)';
        setTimeout(() => {
            card.style.transform = 'scale(1)';
        }, 200);
    }
}

// Update chart with new data
function updateChart(newData) {
    if (!sensorChart) return;

    const now = new Date();
    const timeLabel = now.toLocaleTimeString('en-US', {hour12: false, hour: '2-digit', minute: '2-digit'});

    // Thêm label mới
    sensorChart.data.labels.push(timeLabel);
    // Giữ độ dài tối đa
    if (sensorChart.data.labels.length > MAX_POINTS) sensorChart.data.labels.shift();

    // Temperature
    sensorChart.data.datasets[0].data.push(newData.t);
    if (sensorChart.data.datasets[0].data.length > MAX_POINTS) sensorChart.data.datasets[0].data.shift();

    // Humidity
    sensorChart.data.datasets[1].data.push(newData.h);
    if (sensorChart.data.datasets[1].data.length > MAX_POINTS) sensorChart.data.datasets[1].data.shift();

    // Light
    const lightValue = newData.lx || newData.lux || 0;
    sensorChart.data.datasets[2].data.push(lightValue);
    if (sensorChart.data.datasets[2].data.length > MAX_POINTS) sensorChart.data.datasets[2].data.shift();

    sensorChart.update('none');
    saveChartCache();
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

function loadChartCache() {
    try {
        const raw = localStorage.getItem(LS_KEY_CHART);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || !Array.isArray(obj.labels)) return null;
        return obj;
    } catch { return null; }
}

// Setup device control handlers
async function setupDeviceControls() {
    // Ensure all toggles start OFF until we load real state
    document.querySelectorAll('.toggle-switch').forEach(t => t.classList.remove('active'));
    // Also reset visual effects
    document.querySelectorAll('.devices-panel .device-item').forEach(item => item.classList.remove('active-light','active-fan','active-speaker'));
    // Start with controls disabled until we know MQTT status
    setControlsDisabled(true);

    // Load cached device states ngay lập tức (nếu có)
    try {
        const raw = localStorage.getItem(LS_KEY_DEVICES);
        if (raw) {
            const cached = JSON.parse(raw);
            updateDeviceToggles(cached);
        }
    } catch {}

    // Load current device states from server (đồng bộ lại)
    try {
        const response = await fetch(`${API_BASE_URL}/api/devices`);
        const result = await response.json();
        
        // Handle new API response format
        const deviceStates = result.success ? result.data : result;
        
        // Update toggle switches based on actual states
        updateDeviceToggles(deviceStates);
    } catch (error) {
        console.error('Error loading device states:', error);
    }
    
    // Find all toggle switches
    const toggleSwitches = document.querySelectorAll('.toggle-switch');
    
    toggleSwitches.forEach((toggle, index) => {
        toggle.addEventListener('click', function() {
            if (!controlsEnabled || this.classList.contains('disabled')) {
                // ignore clicks when controls are disabled
                return;
            }
            // Determine device based on index or add data attributes
            let device = '';
            switch(index) {
                case 0: device = 'led'; break;
                case 1: device = 'fan'; break;
                case 2: device = 'spe'; break;
                default: device = 'led';
            }

            const willBeActive = !this.classList.contains('active');
            const action = willBeActive ? 'on' : 'off';

            // Optimistically toggle UI and icon effects; SSE will correct if needed
            this.classList.toggle('active');
            const item = document.querySelectorAll('.devices-panel .device-item')[index];
            if (item) {
                const isOn = this.classList.contains('active');
                item.classList.toggle('active-light', device === 'led' && isOn);
                item.classList.toggle('active-fan', device === 'fan' && isOn);
                item.classList.toggle('active-speaker', device === 'spe' && isOn);
                if (!isOn) item.classList.remove('active-light','active-fan','active-speaker');
            }
            controlDevice(device, action).catch(() => {
                // revert optimistic toggle on error
                this.classList.toggle('active');
                if (item) {
                    const isOn = this.classList.contains('active');
                    item.classList.toggle('active-light', device === 'led' && isOn);
                    item.classList.toggle('active-fan', device === 'fan' && isOn);
                    item.classList.toggle('active-speaker', device === 'spe' && isOn);
                    if (!isOn) item.classList.remove('active-light','active-fan','active-speaker');
                }
            });
        });
    });
}

// Update toggle switches based on device states
function updateDeviceToggles(deviceStates) {
    try { localStorage.setItem(LS_KEY_DEVICES, JSON.stringify(deviceStates)); } catch {}
    const toggleSwitches = document.querySelectorAll('.toggle-switch');
    const deviceItems = document.querySelectorAll('.devices-panel .device-item');
    
    toggleSwitches.forEach((toggle, index) => {
        let device = '';
        switch(index) {
            case 0: device = 'led'; break;
            case 1: device = 'fan'; break;
            case 2: device = 'spe'; break;
        }
        
        if (device && deviceStates[device] !== undefined) {
            const isOn = !!deviceStates[device];
            toggle.classList.toggle('active', isOn);
            const item = deviceItems[index];
            if (item) {
                item.classList.toggle('active-light', device === 'led' && isOn);
                item.classList.toggle('active-fan', device === 'fan' && isOn);
                item.classList.toggle('active-speaker', device === 'spe' && isOn);
                if (!isOn) item.classList.remove('active-light','active-fan','active-speaker');
            }
        }
    });
}

// Update single device toggle switch
function updateDeviceToggle(device, state) {
    const toggleSwitches = document.querySelectorAll('.toggle-switch');
    const deviceItems = document.querySelectorAll('.devices-panel .device-item');
    let deviceIndex = -1;
    
    switch(device) {
        case 'led': deviceIndex = 0; break;
        case 'fan': deviceIndex = 1; break;
        case 'spe': deviceIndex = 2; break;
    }
    
    if (deviceIndex !== -1 && toggleSwitches[deviceIndex]) {
        const toggle = toggleSwitches[deviceIndex];
        const isOn = !!state;
        toggle.classList.toggle('active', isOn);
        const item = deviceItems[deviceIndex];
        if (item) {
            item.classList.toggle('active-light', device === 'led' && isOn);
            item.classList.toggle('active-fan', device === 'fan' && isOn);
            item.classList.toggle('active-speaker', device === 'spe' && isOn);
            if (!isOn) item.classList.remove('active-light','active-fan','active-speaker');
        }
        try {
            const raw = localStorage.getItem(LS_KEY_DEVICES);
            const obj = raw ? JSON.parse(raw) : {};
            obj[device] = isOn ? 1 : 0;
            localStorage.setItem(LS_KEY_DEVICES, JSON.stringify(obj));
        } catch {}
    }
}

// Control device via API
async function controlDevice(device, action) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/control`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ device, action })
        });
        
        if (!response.ok) {
            const text = await response.text().catch(()=>'');
            throw new Error(text || 'Failed to control device');
        }
        
        const result = await response.json();
        
    } catch (error) {
        console.error('Error controlling device:', error);
        // Optionally revert toggle state on error
        throw error;
    }
}


// Clean up connections when page unloads
window.addEventListener('beforeunload', function() {
    if (sseConnection) {
        sseConnection.close();
    }
});

// Initialize page based on available DOM elements
document.addEventListener('DOMContentLoaded', function() {
    // Dashboard (chart + device controls)
    if (document.getElementById('sensor-chart')) {
        initializeDashboard();
    }

    // Sensor Log/Action Log are handled by search-system.js; no init needed here
});
