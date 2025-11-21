// server/mqtt.js
import mqtt from 'mqtt';
import { db } from './db.js';
import { broadcast } from './sse.js';

let mqttClient;

export function initMqtt() {
    try {
        const mqttUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
        
        mqttClient = mqtt.connect(mqttUrl, {
            username: process.env.MQTT_USERNAME,
            password: process.env.MQTT_PASSWORD,
            clientId: 'server_backend_' + Math.random().toString(16).substr(2, 8)
        });

        mqttClient.on('connect', () => {
            console.log('✅ MQTT Connected to Broker');
            broadcast({ type: 'mqtt', status: 'connected' });
            
            // Subscribe các topic cần thiết
            mqttClient.subscribe(['sensors', 'esp32/#'], (err) => {
                if (!err) console.log('📡 Subscribed to topics: sensors, esp32/#');
            });
        });

        mqttClient.on('message', async (topic, message) => {
            const payload = message.toString().trim();
            
            // 1. Xử lý dữ liệu Cảm biến (Topic: sensors)
            if (topic === 'sensors') {
                console.log(`📥 Sensor Data: ${payload}`); // Log để kiểm tra

                // Parse dữ liệu (Bây giờ chỉ là 1 số float duy nhất)
                const lux = parseFloat(payload);

                if (!isNaN(lux)) {
                    // Lưu vào DB (t=0, h=0, chỉ lưu lux)
                    if (db) {
                        try {
                            // Sửa lại query DB cho phù hợp
                            const query = 'INSERT INTO data_sensor (t, h, lux, time_stamp) VALUES (0, 0, ?, NOW())';
                            await db.execute(query, [lux]);
                        } catch (e) {
                            console.error('⚠️ DB Save Error:', e.message);
                        }
                    }

                    // Gửi xuống Web ngay lập tức (Quan trọng!)
                    broadcast({
                        type: 'sensor',
                        lux: lux,       // Gửi đúng trường lux
                        lx: lux,        // Gửi thêm lx để dự phòng
                        time_stamp: new Date().toISOString()
                    });
                }
            }

            // 2. Xử lý phản hồi trạng thái thiết bị (Topic: esp32/...)
            if (topic.startsWith('esp32/')) {
                const deviceName = topic.split('/')[1]; // Lấy tên: led, fan, spe
                const isOn = (payload === '1');
                
                // Cập nhật DB
                if (db) {
                    try {
                        await db.execute('UPDATE device SET status=? WHERE device_name=?', [isOn ? 1 : 0, deviceName]);
                    } catch (e) {}
                }

                // Gửi xuống Web để cập nhật nút bấm
                broadcast({ 
                    type: 'device_update', 
                    device: deviceName, 
                    state: isOn ? 1 : 0 
                });
            }
        });

        mqttClient.on('error', (err) => {
            console.error('❌ MQTT Error:', err.message);
            broadcast({ type: 'mqtt', status: 'disconnected' });
        });

    } catch (error) {
        console.error('Init MQTT Failed:', error);
    }
}

export { mqttClient };