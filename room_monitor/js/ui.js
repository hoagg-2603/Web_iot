// js/ui.js
export const LS_KEY_DEVICES = 'room_monitor_devices_cache_v1';

function animateSensorCard(cardId) {
    const card = document.getElementById(cardId);
    if (card) {
        card.style.transform = 'scale(1.02)';
        setTimeout(() => {
            card.style.transform = 'scale(1)';
        }, 200);
    }
}

export function setControlsDisabled(disabled) {
    const toggles = document.querySelectorAll('.toggle-switch');
    toggles.forEach(t => {
        t.classList.toggle('disabled', disabled);
        t.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    });
}

export function updateSensorDisplay(sensorData) {
    if (!sensorData) return;
    const { t, h, lx } = sensorData;

    const tempEl = document.getElementById('temperature-value');
    if (tempEl && typeof t === 'number') tempEl.textContent = t.toFixed(1);
    
    const humEl = document.getElementById('humidity-value');
    if (humEl && typeof h === 'number') humEl.textContent = h.toFixed(1);
    
    const lightEl = document.getElementById('light-value');
    if (lightEl && typeof lx === 'number') lightEl.textContent = Math.round(lx);
    
    animateSensorCard('temperature-card');
    animateSensorCard('humidity-card'); 
    animateSensorCard('light-card');
}

export function updateDeviceToggles(deviceStates) {
    try { localStorage.setItem(LS_KEY_DEVICES, JSON.stringify(deviceStates)); } catch {}
    
    updateDeviceToggle('led', deviceStates.led);
    updateDeviceToggle('fan', deviceStates.fan);
    updateDeviceToggle('spe', deviceStates.spe);
}

export function updateDeviceToggle(device, state) {
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
        const item = deviceItems[deviceIndex];
        const isOn = !!state;

        // Gỡ loading (quan trọng)
        toggle.classList.remove('loading');
        // Cập nhật trạng thái
        toggle.classList.toggle('active', isOn);
        
        if (item) {
            item.classList.toggle('active-light', device === 'led' && isOn);
            item.classList.toggle('active-fan', device === 'fan' && isOn);
            item.classList.toggle('active-speaker', device === 'spe' && isOn);
            if (!isOn) item.classList.remove('active-light','active-fan','active-speaker');
        }
        
        // Cập nhật cache
        try {
            const raw = localStorage.getItem(LS_KEY_DEVICES);
            const obj = raw ? JSON.parse(raw) : {};
            obj[device] = isOn ? 1 : 0;
            localStorage.setItem(LS_KEY_DEVICES, JSON.stringify(obj));
        } catch {}
    }
}