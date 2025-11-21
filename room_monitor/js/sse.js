// js/sse.js
const SSE_URL = 'http://localhost:3000/stream';
let sseConnection = null;

export function setupSSEConnection(callbacks) {
    const { onMqttStatus, onDeviceUpdate, onInitialState, onSensorData } = callbacks;

    if (sseConnection) sseConnection.close();
    
    sseConnection = new EventSource(SSE_URL);
    
    sseConnection.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);
            
            if (data.type === 'mqtt') {
                onMqttStatus(data.status === 'connected');
                return;
            }
            if (data.type === 'device_update') {
                onDeviceUpdate(data.device, data.state);
                return;
            }
            if (data.type === 'initial_state') {
                onInitialState(data.states);
                return;
            }
            if (data.type === 'sensor' || data.t !== undefined) {
                const sensorData = {
                    // t và h có thể undefined cũng không sao
                    t: data.t,
                    h: data.h, 
                    // Quan trọng là lấy được Lux
                    lx: data.lx || data.lux || data.light || 0
                };
                
                // 👇 SỬA LẠI: Luôn gọi hàm onSensorData để cập nhật giao diện
                onSensorData(sensorData);
            }
        } catch (error) {}
    };
    
    sseConnection.onerror = function() {
        onMqttStatus(false); // Coi như mất kết nối MQTT nếu SSE lỗi
        setTimeout(setupSSEConnection, 5000, callbacks); // Thử kết nối lại
    };

    window.addEventListener('beforeunload', () => {
        if (sseConnection) sseConnection.close();
    });
}