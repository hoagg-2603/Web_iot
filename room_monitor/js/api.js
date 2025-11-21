// js/api.js


const API_BASE_URL = 'http://localhost:3000';

export async function loadInitialSensorData() {
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

export async function fetchDeviceStates() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/devices`);
        const result = await response.json();
        return result.success ? result.data : result;
    } catch (error) {
        console.error('Error loading device states:', error);
        // Trả về mặc định nếu lỗi
        return { led: 0, fan: 0, spe: 0 };
    }
}

export async function controlDevice(device, action) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device, action })
        });
        
        if (!response.ok) {
            const text = await response.text().catch(()=>'');
            throw new Error(text || 'Failed to control device');
        }
        
        return await response.json();
    } catch (error) {
        console.error('Error controlling device:', error);
        throw error;
    }
}