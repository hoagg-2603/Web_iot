import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import mqtt from 'mqtt';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables explicitly from this server directory (was failing when running from project root)
import fs from 'fs';
import os from 'os';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });
if (!process.env.MQTT_BROKER_URL || !process.env.DB_HOST) {
    console.warn('⚠️  Cảnh báo: Biến môi trường chưa được nạp đầy đủ. Hãy đảm bảo file .env nằm trong thư mục server và tên biến đúng.');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Lightweight debug logger (enable with LOG_LEVEL=debug)
const VERBOSE = (process.env.LOG_LEVEL || '').toLowerCase() === 'debug';
const logDebug = (...args) => { if (VERBOSE) console.log(...args); };

const app = express();
const PORT = process.env.PORT || 3000;

// =============================
// SSE CLIENT MANAGEMENT
// =============================
const sseClients = new Set(); // store { id, res }
let clientIdCounter = 0;

function sendSseEvent(res, data) {
    try {
        res.write('data: ' + JSON.stringify(data) + '\n\n');
    } catch (e) {
        // ignore broken pipe
    }
}

function broadcast(data) {
    for (const client of sseClients) {
        sendSseEvent(client.res, data);
    }
}

// Middleware
app.use(cors());
app.use(express.json());
// Serve static assets from project root (index.html, pages/, css/, assets/)
app.use(express.static(path.join(__dirname, '..')));

// Database connection
let db;
async function initDatabase() {
    try {
        db = mysql.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });
    logDebug('✅ Database pool created');

        // Create tables if they don't exist
        const createSensorTable = `CREATE TABLE IF NOT EXISTS data_sensor (
            id_data INT AUTO_INCREMENT PRIMARY KEY,
            t FLOAT,
            h FLOAT,
            lux FLOAT,
            time_stamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`;
        const createDeviceTable = `CREATE TABLE IF NOT EXISTS device (
            device_name VARCHAR(50) PRIMARY KEY,
            status TINYINT(1) NOT NULL DEFAULT 0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )`;
        const createActionLogTable = `CREATE TABLE IF NOT EXISTS action_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            actor VARCHAR(50),
            device VARCHAR(50),
            action VARCHAR(20),
            time_stamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`;
        await db.execute(createSensorTable);
        await db.execute(createDeviceTable);
        await db.execute(createActionLogTable);

        // Normalize existing sensor values to 1 decimal to stabilize float equality
        try {
            const [upd] = await db.execute('UPDATE data_sensor SET t=ROUND(t,1), h=ROUND(h,1), lux=ROUND(lux,1)');
            if (upd && typeof upd.affectedRows === 'number') {
                logDebug(`🛠️ Normalized ${upd.affectedRows} sensor rows to 1-decimal precision`);
            }
        } catch (e) {
            logDebug('ℹ️ Normalize step skipped:', e?.message || e);
        }
        // Deduplicate existing rows (keep smallest id in each group)
        try {
            const [res] = await db.execute(`
                DELETE t1 FROM data_sensor t1
                JOIN data_sensor t2
                  ON t1.time_stamp = t2.time_stamp
                 AND t1.t = t2.t
                 AND t1.h = t2.h
                 AND t1.lux = t2.lux
                 AND t1.id_data > t2.id_data
            `);
            if (res && typeof res.affectedRows === 'number' && res.affectedRows > 0) {
                logDebug(`🧹 Deduplicated data_sensor, removed ${res.affectedRows} rows`);
            }
        } catch (e) {
            // Best-effort; log in debug only
            logDebug('ℹ️ Dedup skip/error:', e?.message || e);
        }

        // Ensure unique index to avoid exact duplicate samples within same second
        try {
            await db.execute("ALTER TABLE data_sensor ADD UNIQUE KEY uniq_sample (time_stamp, t, h, lux)");
            logDebug('🔐 Added unique index uniq_sample on data_sensor(time_stamp,t,h,lux)');
        } catch (e) {
            // If index already exists or duplicate key name, ignore; if duplicates caused failure, we already deduped above
            const code = e?.code || '';
            const errno = e?.errno || 0;
            if (code === 'ER_DUP_KEYNAME' || errno === 1061) {
                // index exists
            } else if (code === 'ER_DUP_ENTRY' || errno === 1062) {
                // If still duplicates, try one more dedup then re-add
                try {
                    await db.execute(`
                        DELETE t1 FROM data_sensor t1
                        JOIN data_sensor t2
                          ON t1.time_stamp = t2.time_stamp
                         AND t1.t = t2.t
                         AND t1.h = t2.h
                         AND t1.lux = t2.lux
                         AND t1.id_data > t2.id_data
                    `);
                    await db.execute("ALTER TABLE data_sensor ADD UNIQUE KEY uniq_sample (time_stamp, t, h, lux)");
                } catch {}
            } else {
                logDebug('ℹ️ Unique index creation skipped:', e?.message || e);
            }
        }
        logDebug('�🛠️  Ensured tables exist (data_sensor, device, action_log)');
    } catch (error) {
        console.error('❌ Database initialization failed:', error);
    }
}
await initDatabase();

// MQTT Client
let mqttClient;
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

    function broadcastMqttStatus(status) {
        try {
            broadcast({ type: 'mqtt', status });
        } catch {}
    }

    mqttClient.on('connect', () => {
    logDebug('✅ MQTT connected successfully');
        broadcastMqttStatus('connected');
        // Subscribe to topics (controlled by env)
        mqttClient.subscribe(topicsToSubscribe, (err, granted) => {
            if (err) {
                console.error('❌ MQTT subscribe error:', err.message);
            } else {
                logDebug('✅ MQTT subscribed topics:', granted.map(g=>g.topic).join(', '));
            }
        });
    });

    // Simple dedup within short window to avoid duplicate saves when broker re-delivers or multiple subs
    let lastSensorSample = { payload: '', ts: 0 };

    mqttClient.on('message', async (topic, message) => {
        try {
            logDebug('📥 MQTT message received:', topic, message.toString());
            
            // Handle sensor data from ESP32 (CSV format: temperature,humidity,light)
            if (topic === 'sensors') {
                const csvData = message.toString().trim();
                const nowMs = Date.now();
                if (lastSensorSample.payload === csvData && (nowMs - lastSensorSample.ts) < 1500) {
                    // Ignore duplicate within ~0.9s
                    logDebug('⏭️  Duplicate sensor MQTT within window, ignored');
                    return;
                }
                const values = csvData.split(',');
                
                if (values.length >= 3) {
                    const data = {
                        t: parseFloat(values[0]),    // temperature
                        h: parseFloat(values[1]),    // humidity
                        lux: parseFloat(values[2])   // light
                    };
                    
                    logDebug('📊 Parsed sensor data:', data);
                    // Set dedup marker early to avoid race on rapid duplicates
                    lastSensorSample = { payload: csvData, ts: nowMs };
                    const row = await saveSensorData(data);
                    // Broadcast immediately via SSE
                    broadcast({
                        type: 'sensor',
                        t: data.t,
                        h: data.h,
                        lux: data.lux,
                        time_stamp: row?.time_stamp || new Date().toISOString()
                    });
                } else {
                    logDebug('⚠️ Invalid sensor data format:', csvData);
                }
            }
            
            // Handle device control feedback from ESP32
            if (topic.startsWith('esp32/')) {
                const data = JSON.parse(message.toString());
                await updateDeviceState(topic, data);
            }
            
            // Handle device control commands
            if (topic === 'led' || topic === 'fan' || topic === 'spe') {
                logDebug('📤 Device control:', topic, message.toString());
            }
            
        } catch (error) {
            console.error('❌ MQTT message processing error:', error);
            logDebug('Raw message:', message.toString());
        }
    });

    mqttClient.on('error', (error) => {
        console.error('❌ MQTT connection error:', error);
        broadcastMqttStatus('disconnected');
        if (String(error).includes('Not authorized') || (error?.code === 5)) {
            console.error('🔐 Gợi ý xử lý:');
            console.error('- Kiểm tra user/password trên broker (mosquitto_passwd).');
            console.error('- Xem ACL có cho phép topic hiện tại không.');
            console.error('- Thử chỉ để MQTT_SUB_TOPICS=sensors để test quyền SUB cơ bản.');
            console.error('- Đổi clientId nếu broker hạn chế sessions trùng.');
        }
    });

    mqttClient.on('close', () => broadcastMqttStatus('disconnected'));
    mqttClient.on('offline', () => broadcastMqttStatus('disconnected'));
    mqttClient.on('end', () => broadcastMqttStatus('disconnected'));
    mqttClient.on('reconnect', () => broadcastMqttStatus('disconnected'));
} catch (error) {
    console.error('❌ MQTT setup failed:', error);
}

// Save sensor data to database
async function saveSensorData(data) {
    try {
        if (db && data.t !== undefined && data.h !== undefined && data.lux !== undefined) {
            const query = 'INSERT IGNORE INTO data_sensor (t, h, lux, time_stamp) VALUES (?, ?, ?, NOW())';
            const [result] = await db.execute(query, [data.t, data.h, data.lux]);
            if (result.affectedRows === 0) {
                logDebug('ℹ️ Duplicate sensor sample ignored:', data);
                return null;
            }
            logDebug('✅ Sensor data saved:', data);
            return { id_data: result.insertId, ...data, time_stamp: new Date().toISOString() };
        }
    } catch (error) {
        console.error('❌ Error saving sensor data:', error);
    }
    return null;
}

// Update device state
async function updateDeviceState(topic, data) {
    try {
        const deviceName = topic.split('/')[1]; // Extract device name from topic
        if (db && deviceName && data.status !== undefined) {
            const query = 'UPDATE device SET status = ? WHERE device_name = ?';
            await db.execute(query, [data.status, deviceName]);
            logDebug('✅ Device state updated:', deviceName, data.status);
        }
    } catch (error) {
        console.error('❌ Error updating device state:', error);
    }
}

// API Routes

// Get sensor data (latest OR paginated list)
// Frontend calls /api/sensors?limit=20 expecting array OR /api/sensors?page=&limit= for paginated table
app.get('/api/sensors', async (req, res) => {
    try {
        const { page, limit } = req.query;
        // Pagination mode
        if (page || limit) {
            const pageNum = Math.max(parseInt(page) || 1, 1);
            const pageSize = Math.min(Math.max(parseInt(limit) || 20, 1), 200);
            const offset = (pageNum - 1) * pageSize;
            // Optional search support
            const search = (req.query.search || '').trim();
            const field = (req.query.field || '').toLowerCase();
            // Structured filters
            const timeFromStr = (req.query.timeFrom || '').trim();
            const timeToStr = (req.query.timeTo || '').trim();
            const tMin = req.query.tMin !== undefined && req.query.tMin !== '' ? Number(req.query.tMin) : undefined;
            const tMax = req.query.tMax !== undefined && req.query.tMax !== '' ? Number(req.query.tMax) : undefined;
            const hMin = req.query.hMin !== undefined && req.query.hMin !== '' ? Number(req.query.hMin) : undefined;
            const hMax = req.query.hMax !== undefined && req.query.hMax !== '' ? Number(req.query.hMax) : undefined;
            const luxMin = req.query.luxMin !== undefined && req.query.luxMin !== '' ? Number(req.query.luxMin) : undefined;
            const luxMax = req.query.luxMax !== undefined && req.query.luxMax !== '' ? Number(req.query.luxMax) : undefined;

            function parseTimeStringToSql(s) {
                if (!s) return null;
                const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/);
                if (!m) return null;
                let [, dd, MM, yyyy, hh, mm, ss] = m;
                dd = String(dd).padStart(2, '0');
                MM = String(MM).padStart(2, '0');
                hh = String(hh || '00').padStart(2, '0');
                mm = String(mm || '00').padStart(2, '0');
                ss = String(ss || '00').padStart(2, '0');
                return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
            }

            const whereParts = [];
            const params = [];
            // Apply structured filters first (AND logic)
            const fromSql = parseTimeStringToSql(timeFromStr);
            const toSql = parseTimeStringToSql(timeToStr);
            if (fromSql) { whereParts.push('time_stamp >= ?'); params.push(fromSql); }
            if (toSql) { whereParts.push('time_stamp <= ?'); params.push(toSql); }
            if (typeof tMin === 'number' && !Number.isNaN(tMin)) { whereParts.push('t >= ?'); params.push(tMin); }
            if (typeof tMax === 'number' && !Number.isNaN(tMax)) { whereParts.push('t <= ?'); params.push(tMax); }
            if (typeof hMin === 'number' && !Number.isNaN(hMin)) { whereParts.push('h >= ?'); params.push(hMin); }
            if (typeof hMax === 'number' && !Number.isNaN(hMax)) { whereParts.push('h <= ?'); params.push(hMax); }
            if (typeof luxMin === 'number' && !Number.isNaN(luxMin)) { whereParts.push('lux >= ?'); params.push(luxMin); }
            if (typeof luxMax === 'number' && !Number.isNaN(luxMax)) { whereParts.push('lux <= ?'); params.push(luxMax); }
            if (search) {
                const likePattern = search + '%';
                if (field === 'time') {
                    // dd/mm/yyyy hh:mm:ss exact hoặc prefix
                    const isFull = search.length >= 19; // 'dd/mm/yyyy hh:mm:ss' = 19 chars
                    if (isFull) {
                        whereParts.push("DATE_FORMAT(time_stamp, '%d/%m/%Y %H:%i:%s') = ?");
                        params.push(search);
                    } else {
                        whereParts.push("DATE_FORMAT(time_stamp, '%d/%m/%Y %H:%i:%s') LIKE ?");
                        params.push(likePattern);
                    }
                } else if (field === 'temperature') {
                    const hasDecimal = /\./.test(search);
                    if (hasDecimal) {
                        whereParts.push('ROUND(t,1) = ?');
                        params.push(Number(search));
                    } else {
                        whereParts.push('CAST(t AS CHAR) LIKE ?');
                        params.push(likePattern);
                    }
                } else if (field === 'humidity') {
                    const hasDecimal = /\./.test(search);
                    if (hasDecimal) {
                        whereParts.push('ROUND(h,1) = ?');
                        params.push(Number(search));
                    } else {
                        whereParts.push('CAST(h AS CHAR) LIKE ?');
                        params.push(likePattern);
                    }
                } else if (field === 'light') {
                    const hasDecimal = /\./.test(search);
                    if (hasDecimal) {
                        whereParts.push('ROUND(lux,1) = ?');
                        params.push(Number(search));
                    } else {
                        whereParts.push('CAST(lux AS CHAR) LIKE ?');
                        params.push(likePattern);
                    }
                } else if (field === 'all' || field === '' || field === 'undefined') {
                    // Phân loại: nếu chuỗi trông giống thời gian -> ưu tiên tìm theo thời gian; nếu là số -> tìm trên t/h/lux; ngược lại -> OR tất cả
                    const timeFullRegex = /^\d{2}\/\d{2}\/\d{4}\s\d{2}:\d{2}:\d{2}$/;
                    const timePrefixRegex = /^\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}(?::\d{1,2}(?::\d{1,2})?)?)?$/;
                    const numericRegex = /^-?\d+(?:\.\d+)?$/;
                    if (timeFullRegex.test(search)) {
                        whereParts.push("DATE_FORMAT(time_stamp, '%d/%m/%Y %H:%i:%s') = ?");
                        params.push(search);
                    } else if (timePrefixRegex.test(search)) {
                        whereParts.push("DATE_FORMAT(time_stamp, '%d/%m/%Y %H:%i:%s') LIKE ?");
                        params.push(likePattern);
                    } else if (numericRegex.test(search)) {
                        const hasDecimal = /\./.test(search);
                        if (hasDecimal) {
                            // Số có phần thập phân: so khớp bằng tuyệt đối trên ROUND(.,1)
                            whereParts.push('(ROUND(t,1) = ? OR ROUND(h,1) = ? OR ROUND(lux,1) = ?)');
                            const val = Number(search);
                            params.push(val, val, val);
                        } else {
                            // Số nguyên: prefix match
                            whereParts.push('(CAST(t AS CHAR) LIKE ? OR CAST(h AS CHAR) LIKE ? OR CAST(lux AS CHAR) LIKE ?)');
                            params.push(likePattern, likePattern, likePattern);
                        }
                    } else {
                        // fallback: OR tất cả cột hiển thị
                        whereParts.push("(DATE_FORMAT(time_stamp, '%d/%m/%Y %H:%i:%s') LIKE ? OR CAST(t AS CHAR) LIKE ? OR CAST(h AS CHAR) LIKE ? OR CAST(lux AS CHAR) LIKE ?)");
                        params.push(likePattern, likePattern, likePattern, likePattern);
                    }
                }
            }
            const whereClause = whereParts.length ? ('WHERE ' + whereParts.join(' AND ')) : '';
            // Avoid parameter placeholders for LIMIT/OFFSET (some MySQL modes reject)
            const selectSql = `SELECT * FROM data_sensor ${whereClause} ORDER BY time_stamp DESC LIMIT ${pageSize} OFFSET ${offset}`;
            const countSql = `SELECT COUNT(*) AS total FROM data_sensor ${whereClause}`;
            let dataRows, countRows;
            if (params.length) {
                [dataRows] = await db.query(selectSql, params);
                [[{ total: countRows }]] = await db.query(countSql, params);
            } else {
                [dataRows] = await db.query(selectSql);
                [[{ total: countRows }]] = await db.query(countSql);
            }
            const total = countRows || 0;
            const totalPages = Math.max(Math.ceil(total / pageSize), 1);
            return res.json({
                success: true,
                data: dataRows,
                pagination: {
                    currentPage: pageNum,
                    totalPages,
                    totalRecords: total,
                    pageSize,
                    hasPrev: pageNum > 1,
                    hasNext: pageNum < totalPages
                }
            });
        }
        // Simple latest + optional limit list
        const lim = Math.min(parseInt(req.query.limit) || 1, 200);
        const [rows] = await db.query(`SELECT * FROM data_sensor ORDER BY time_stamp DESC LIMIT ${lim}`);
        if (lim === 1) {
            return res.json({ success: true, data: rows[0] || null });
        }
        return res.json({ success: true, data: rows });
    } catch (error) {
        console.error('❌ Error getting sensor data:', error);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Get sensor history
app.get('/api/sensors/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const [rows] = await db.execute('SELECT * FROM data_sensor ORDER BY time_stamp DESC LIMIT ?', [limit]);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('❌ Error getting sensor history:', error);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Get device status
app.get('/api/devices', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT device_name, status FROM device');
        // Chuyển thành dạng mapping { led: 1, fan: 0, spe: 1 }
        const mapping = {};
        for (const r of rows) {
            mapping[r.device_name] = r.status;
        }
        // Nếu bảng rỗng, trả về mặc định
        if (Object.keys(mapping).length === 0) {
            mapping.led = 0;
            mapping.fan = 0;
            mapping.spe = 0;
        }
        res.json({ success: true, data: mapping });
    } catch (error) {
        console.error('❌ Error getting devices:', error);
        // Fallback thay vì 500 để frontend vẫn hiển thị được
        res.json({ success: true, data: { led: 0, fan: 0, spe: 0 }, warning: 'device table missing' });
    }
});

// Legacy route (keep for compatibility)
app.post('/api/devices/:deviceName/control', async (req, res) => {
    return controlDeviceHandler(req, res, req.params.deviceName);
});

// New route matching frontend (POST /api/control {device, action})
app.post('/api/control', async (req, res) => {
    const { device, action } = req.body || {};
    if (!device) return res.status(400).json({ success: false, error: 'Missing device' });
    return controlDeviceHandler(req, res, device, action);
});

async function controlDeviceHandler(req, res, deviceName, actionBody) {
    try {
        const action = actionBody || req.body?.action; // support either param/body
        if (!action) {
            return res.status(400).json({ success: false, error: 'Missing action' });
        }
        const allowedDevices = ['led','fan','spe'];
        if (!allowedDevices.includes(deviceName)) {
            return res.status(400).json({ success: false, error: 'Invalid device' });
        }
        const isOn = ['on','1',1,true,'true'].includes(String(action).toLowerCase());
        // Publish simple payload ("1" / "0") on topic = deviceName to match ESP & mosquitto examples
        if (mqttClient && mqttClient.connected) {
            mqttClient.publish(deviceName, isOn ? '1' : '0');
            logDebug('📤 Device command published:', deviceName, isOn ? '1' : '0');
            // Persist (upsert) device state to DB so trạng thái không bị reset khi reload trang
            try {
                if (db) {
                    // Try update first
                    const [result] = await db.execute('UPDATE device SET status=? WHERE device_name=?', [isOn ? 1 : 0, deviceName]);
                    if (result.affectedRows === 0) {
                        // Insert if not exists
                        await db.execute('INSERT INTO device (device_name, status) VALUES (?, ?)', [deviceName, isOn ? 1 : 0]);
                    }
                }
            } catch (e) {
                console.warn('⚠️ Không thể lưu trạng thái thiết bị vào DB:', e.message);
            }
            // Log action (best effort)
            logAction('USER', deviceName, isOn ? 'ON' : 'OFF');
            broadcast({ type: 'device_update', device: deviceName, state: isOn ? 1 : 0 });
            return res.json({ success: true, message: 'Command sent', device: deviceName, state: isOn ? 1 : 0 });
        }
        return res.status(503).json({ success: false, error: 'MQTT not connected' });
    } catch (error) {
        console.error('❌ Error controlling device:', error);
        return res.status(500).json({ success: false, error: 'Server error' });
    }
}

async function logAction(actor, device, action) {
    try {
        if (!db) return;
        await db.execute('INSERT INTO action_log (actor, device, action, time_stamp) VALUES (?, ?, ?, NOW())', [actor, device, action]);
    } catch (e) {
        // table may not exist; ignore
    }
}

// Actions list endpoint (pagination + optional search)
app.get('/api/actions', async (req, res) => {
    try {
        const pageNum = Math.max(parseInt(req.query.page) || 1, 1);
        const pageSize = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 200);
        const offset = (pageNum - 1) * pageSize;
        const search = (req.query.search || '').trim();
        const field = (req.query.field || 'all').toLowerCase();
        const whereParts = [];
        const params = [];
        if (search) {
            const likeAnywhere = '%' + search + '%';
            const likePrefix = search + '%';
            if (field === 'time') {
                // Support exact or prefix match on formatted timestamp dd/mm/yyyy hh:mm:ss
                const isFull = search.length >= 19; // dd/mm/yyyy hh:mm:ss
                if (isFull) {
                    whereParts.push("DATE_FORMAT(time_stamp, '%d/%m/%Y %H:%i:%s') = ?");
                    params.push(search);
                } else {
                    whereParts.push("DATE_FORMAT(time_stamp, '%d/%m/%Y %H:%i:%s') LIKE ?");
                    params.push(likePrefix);
                }
            } else if (field === 'device') {
                whereParts.push('`device` LIKE ?');
                params.push(likeAnywhere);
            } else if (field === 'action') {
                whereParts.push('`action` LIKE ?');
                params.push(likeAnywhere);
            } else if (field === 'actor') {
                whereParts.push('`actor` LIKE ?');
                params.push(likeAnywhere);
            } else { // all
                // Include time prefix search as well to align with Sensor Log behavior
                whereParts.push("(DATE_FORMAT(time_stamp, '%d/%m/%Y %H:%i:%s') LIKE ? OR `device` LIKE ? OR `action` LIKE ? OR `actor` LIKE ?)");
                params.push('%' + search + '%', likeAnywhere, likeAnywhere, likeAnywhere);
            }
        }
        const whereClause = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : '';
        // Build queries; avoid parameter placeholders for LIMIT/OFFSET
        const selectSql = `SELECT * FROM action_log ${whereClause} ORDER BY time_stamp DESC LIMIT ${pageSize} OFFSET ${offset}`;
        const countSql = `SELECT COUNT(*) AS total FROM action_log ${whereClause}`;
        let dataRows, totalRows;
        if (params.length) {
            [dataRows] = await db.query(selectSql, params);
            [[{ total: totalRows }]] = await db.query(countSql, params);
        } else {
            [dataRows] = await db.query(selectSql);
            [[{ total: totalRows }]] = await db.query(countSql);
        }
        const data = dataRows;
        const total = totalRows;
        const totalPages = Math.max(Math.ceil(total / pageSize), 1);
        return res.json({
            success: true,
            data,
            pagination: {
                currentPage: pageNum,
                totalPages,
                totalRecords: total,
                pageSize,
                hasPrev: pageNum > 1,
                hasNext: pageNum < totalPages
            }
        });
    } catch (error) {
        console.error('❌ Error getting actions:', error);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Server-Sent Events for real-time updates
app.get('/stream', async (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });
    const id = ++clientIdCounter;
    sseClients.add({ id, res });
    console.log('📡 SSE client connected (id=' + id + ')');
    sendSseEvent(res, { type: 'connected', id });

    // Send initial latest sensor value (if any)
    try {
        const [rows] = await db.query('SELECT * FROM data_sensor ORDER BY time_stamp DESC LIMIT 1');
        if (rows[0]) sendSseEvent(res, { type: 'sensor', ...rows[0] });
    } catch {}

    // Send initial device states mapping
    try {
        const [drows] = await db.execute('SELECT device_name, status FROM device');
        const mapping = { led: 0, fan: 0, spe: 0 };
        for (const r of drows) mapping[r.device_name] = r.status;
        sendSseEvent(res, { type: 'initial_state', states: mapping });
    } catch (e) {
        // fallback default mapping
        sendSseEvent(res, { type: 'initial_state', states: { led:0, fan:0, spe:0 } });
    }

    // Send initial MQTT status
    try {
        sendSseEvent(res, { type: 'mqtt', status: (mqttClient && mqttClient.connected) ? 'connected' : 'disconnected' });
    } catch {}

    // Keep alive
    const heartbeat = setInterval(() => {
        sendSseEvent(res, { type: 'heartbeat', timestamp: new Date().toISOString() });
    }, 30000);

    req.on('close', () => {
        clearInterval(heartbeat);
        for (const c of sseClients) { if (c.id === id) { sseClients.delete(c); break; } }
        console.log('📡 SSE client disconnected (id=' + id + ')');
    });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: db ? 'connected' : 'disconnected',
        mqtt: mqttClient && mqttClient.connected ? 'connected' : 'disconnected'
    });
});

// Serve client files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log('🚀 Server running on http://localhost:' + PORT);
    console.log('📊 Database:', process.env.DB_HOST);
    console.log('📡 MQTT Broker:', process.env.MQTT_BROKER_URL);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🔄 Shutting down gracefully...');
    
    if (mqttClient) {
        mqttClient.end();
    }
    
    if (db) {
        await db.end();
    }
    
    process.exit(0);
});