// server/mqtt.js
import mqtt from 'mqtt';
import { db } from './db.js';
import { broadcast } from './sse.js';

const VERBOSE = (process.env.LOG_LEVEL || '').toLowerCase() === 'debug';
const logDebug = (...args) => { if (VERBOSE) console.log(...args); };

let mqttClient;
let lastSensorSample = { payload: '', ts: 0 };

async function saveSensorData(data) {
    try {
        if (db && data.t !== undefined && data.h !== undefined && data.lux !== undefined) {
            const query = 'INSERT IGNORE INTO data_sensor (t, h, lux, time_stamp) VALUES (?, ?, ?, NOW())';
            const [result] = await db.execute(query, [data.t, data.h, data.lux]);
            if (result.affectedRows === 0) {
                logDebug('ℹDuplicate sensor sample ignored:', data);
                return null;
            }
            logDebug('Sensor data saved:', data);
            return { id_data: result.insertId, ...data, time_stamp: new Date().toISOString() };
        }
    } catch (error) {
        console.error('Error saving sensor data:', error);
    }
    return null;
}

async function updateDeviceState(topic, data) {
    try {
        const deviceName = topic.split('/')[1];
        if (db && deviceName && data.status !== undefined) {
            const query = 'UPDATE device SET status = ? WHERE device_name = ?';
            await db.execute(query, [data.status, deviceName]);
            logDebug('Device state updated:', deviceName, data.status);
        }
    } catch (error) {
        console.error('Error updating device state:', error);
    }
}

export function initMqtt() {
    try {
        const subTopicsEnv = (process.env.MQTT_SUB_TOPICS || '').split(',').map(s=>s.trim()).filter(Boolean);
        const topicsToSubscribe = subTopicsEnv.length ? subTopicsEnv : ['sensors'];
        const dynamicClientId = (process.env.MQTT_CLIENT_ID && !process.env.MQTT_CLIENT_ID.startsWith('#'))
            ? process.env.MQTT_CLIENT_ID
            : 'room-monitor-' + Math.random().toString(16).slice(2);

        mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, {
            username: process.env.MQTT_USERNAME || undefined,
            password: process.env.MQTT_PASSWORD || undefined,
            reconnectPeriod: 5000,
            clean: true,
            clientId: dynamicClientId
        });

        const broadcastMqttStatus = (status) => broadcast({ type: 'mqtt', status });

        mqttClient.on('connect', () => {
            logDebug('MQTT connected successfully');
            broadcastMqttStatus('connected');
            mqttClient.subscribe(topicsToSubscribe, (err, granted) => {
                if (err) {
                    console.error('QTT subscribe error:', err.message);
                } else {
                    logDebug('MQTT subscribed topics:', granted.map(g=>g.topic).join(', '));
                }
            });
        });

        mqttClient.on('message', async (topic, message) => {
            try {
                logDebug('MQTT message received:', topic, message.toString());
                
                if (topic === 'sensors') {
                    const csvData = message.toString().trim();
                    const nowMs = Date.now();
                    if (lastSensorSample.payload === csvData && (nowMs - lastSensorSample.ts) < 1500) {
                        logDebug('Duplicate sensor MQTT within window, ignored');
                        return;
                    }
                    const values = csvData.split(',');
                    
                    if (values.length >= 3) {
                        const data = { t: parseFloat(values[0]), h: parseFloat(values[1]), lux: parseFloat(values[2]) };
                        logDebug('Parsed sensor data:', data);
                        lastSensorSample = { payload: csvData, ts: nowMs };
                        const row = await saveSensorData(data);
                        
                        // Chỉ broadcast nếu lưu thành công
                        if (row) {
                            broadcast({
                                type: 'sensor',
                                t: data.t,
                                h: data.h,
                                lux: data.lux,
                                time_stamp: row.time_stamp
                            });
                        }
                    } else {
                        logDebug('Invalid sensor data format:', csvData);
                    }
                }
                
                if (topic.startsWith('esp32/')) {
                    const data = JSON.parse(message.toString());
                    await updateDeviceState(topic, data);
                }
                
            } catch (error) {
                console.error('QTT message processing error:', error);
            }
        });

        mqttClient.on('error', (error) => {
            console.error('MQTT connection error:', error);
            broadcastMqttStatus('disconnected');
        });

        mqttClient.on('close', () => broadcastMqttStatus('disconnected'));
        mqttClient.on('offline', () => broadcastMqttStatus('disconnected'));
        mqttClient.on('end', () => broadcastMqttStatus('disconnected'));
        mqttClient.on('reconnect', () => broadcastMqttStatus('disconnected'));

    } catch (error) {
        console.error('MQTT setup failed:', error);
    }
}

export { mqttClient };