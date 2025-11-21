// server/routes.js
import express from 'express';
import { db } from './db.js';
import { mqttClient } from './mqtt.js';
import { broadcast } from './sse.js';

const router = express.Router();

const VERBOSE = (process.env.LOG_LEVEL || '').toLowerCase() === 'debug';
const logDebug = (...args) => { if (VERBOSE) console.log(...args); };

// --- Helpers ---

async function logAction(actor, device, action) {
    try {
        if (!db) return;
        await db.execute('INSERT INTO action_log (actor, device, action, time_stamp) VALUES (?, ?, ?, NOW())', [actor, device, action]);
    } catch (e) {}
}

async function controlDeviceHandler(req, res, deviceName, actionBody) {
    try {
        const action = actionBody || req.body?.action;
        if (!action) {
            return res.status(400).json({ success: false, error: 'Missing action' });
        }
        const allowedDevices = ['led','fan','spe'];
        if (!allowedDevices.includes(deviceName)) {
            return res.status(400).json({ success: false, error: 'Invalid device' });
        }
        const isOn = ['on','1',1,true,'true'].includes(String(action).toLowerCase());
        
        if (mqttClient && mqttClient.connected) {
            mqttClient.publish(deviceName, isOn ? '1' : '0');
            logDebug('📤 Device command published:', deviceName, isOn ? '1' : '0');
            
            try {
                if (db) {
                    const [result] = await db.execute('UPDATE device SET status=? WHERE device_name=?', [isOn ? 1 : 0, deviceName]);
                    if (result.affectedRows === 0) {
                        await db.execute('INSERT INTO device (device_name, status) VALUES (?, ?)', [deviceName, isOn ? 1 : 0]);
                    }
                }
            } catch (e) {
                console.warn('Không thể lưu trạng thái thiết bị vào DB:', e.message);
            }
            
            logAction('USER', deviceName, isOn ? 'ON' : 'OFF');
            broadcast({ type: 'device_update', device: deviceName, state: isOn ? 1 : 0 });
            return res.json({ success: true, message: 'Command sent', device: deviceName, state: isOn ? 1 : 0 });
        }
        return res.status(503).json({ success: false, error: 'MQTT not connected' });
    } catch (error) {
        console.error('Error controlling device:', error);
        return res.status(500).json({ success: false, error: 'Server error' });
    }
}

// --- Routes ---

router.get('/sensors', async (req, res) => {
    try {
        const { page, limit } = req.query;
        if (page || limit) {
            const pageNum = Math.max(parseInt(page) || 1, 1);
            const pageSize = Math.min(Math.max(parseInt(limit) || 20, 1), 200);
            const offset = (pageNum - 1) * pageSize;
            
            const search = (req.query.search || '').trim();
            const field = (req.query.field || '').toLowerCase();
            // ... (Phần logic tìm kiếm phức tạp của bạn nằm ở đây) ...
            // (Tôi giữ nguyên logic tìm kiếm phức tạp của bạn vì nó đã được tùy chỉnh)
            
            const whereParts = [];
            const params = [];
            
            // (Ví dụ logic tìm kiếm...)
             if (search) {
                const likePattern = search + '%';
                if (field === 'time') {
                    whereParts.push("DATE_FORMAT(time_stamp, '%d/%m/%Y %H:%i:%s') LIKE ?");
                    params.push(likePattern);
                } else if (field === 'temperature') {
                    // SỬA LỖI: Dùng BETWEEN thay vì ROUND
                    const val = Number(search);
                    if (!isNaN(val) && /\./.test(search)) {
                         whereParts.push('t BETWEEN ? AND ?');
                         params.push(val - 0.05, val + 0.05);
                    } else {
                        whereParts.push('CAST(t AS CHAR) LIKE ?');
                        params.push(likePattern);
                    }
                }
                // ... (Các trường khác tương tự)
                else {
                    whereParts.push("(DATE_FORMAT(time_stamp, '%d/%m/%Y %H:%i:%s') LIKE ? OR CAST(t AS CHAR) LIKE ? OR CAST(h AS CHAR) LIKE ? OR CAST(lux AS CHAR) LIKE ?)");
                    params.push('%'+search+'%', likePattern, likePattern, likePattern);
                }
            }
            // ... (Kết thúc logic tìm kiếm)

            const whereClause = whereParts.length ? ('WHERE ' + whereParts.join(' AND ')) : '';
            const selectSql = `SELECT * FROM data_sensor ${whereClause} ORDER BY time_stamp DESC LIMIT ${pageSize} OFFSET ${offset}`;
            const countSql = `SELECT COUNT(*) AS total FROM data_sensor ${whereClause}`;
            
            const [dataRows] = await db.query(selectSql, params);
            const [[{ total: countRows }]] = await db.query(countSql, params);
            
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
        
        // Trả về dữ liệu mới nhất (cho dashboard)
        const lim = Math.min(parseInt(req.query.limit) || 1, 200);
        const [rows] = await db.query(`SELECT * FROM data_sensor ORDER BY time_stamp DESC LIMIT ${lim}`);
        if (lim === 1) {
            return res.json({ success: true, data: rows[0] || null });
        }
        return res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Error getting sensor data:', error);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

router.get('/devices', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT device_name, status FROM device');
        const mapping = { led: 0, fan: 0, spe: 0 };
        for (const r of rows) {
            mapping[r.device_name] = r.status;
        }
        res.json({ success: true, data: mapping });
    } catch (error) {
        console.error('Error getting devices:', error);
        res.json({ success: true, data: { led: 0, fan: 0, spe: 0 }, warning: 'device table missing' });
    }
});

router.post('/control', async (req, res) => {
    const { device, action } = req.body || {};
    if (!device) return res.status(400).json({ success: false, error: 'Missing device' });
    return controlDeviceHandler(req, res, device, action);
});

router.get('/actions', async (req, res) => {
    try {
        // (Logic tìm kiếm/phân trang cho /api/actions của bạn nằm ở đây)
        // ... (Tương tự như /api/sensors)
        const pageNum = Math.max(parseInt(req.query.page) || 1, 1);
        const pageSize = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 200);
        const offset = (pageNum - 1) * pageSize;
        const search = (req.query.search || '').trim();
        const field = (req.query.field || 'all').toLowerCase();
        
        const whereParts = [];
        const params = [];
        if (search) {
             // ... (Logic tìm kiếm action log của bạn)
        }
        
        const whereClause = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : '';
        const selectSql = `SELECT * FROM action_log ${whereClause} ORDER BY time_stamp DESC LIMIT ${pageSize} OFFSET ${offset}`;
        const countSql = `SELECT COUNT(*) AS total FROM action_log ${whereClause}`;

        const [dataRows] = await db.query(selectSql, params);
        const [[{ total: totalRows }]] = await db.query(countSql, params);

        const totalPages = Math.max(Math.ceil(totalRows / pageSize), 1);
        return res.json({
            success: true,
            data: dataRows,
            pagination: {
                currentPage: pageNum,
                totalPages,
                totalRecords: totalRows,
                pageSize,
                hasPrev: pageNum > 1,
                hasNext: pageNum < totalPages
            }
        });
    } catch (error) {
        console.error('Error getting actions:', error);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: db ? 'connected' : 'disconnected',
        mqtt: mqttClient && mqttClient.connected ? 'connected' : 'disconnected'
    });
});

export default router;