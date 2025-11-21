// server/sse.js
import { db } from './db.js';
import { mqttClient } from './mqtt.js';

const sseClients = new Set();
let clientIdCounter = 0;

function sendSseEvent(res, data) {
    try {
        res.write('data: ' + JSON.stringify(data) + '\n\n');
    } catch (e) {
        // ignore broken pipe
    }
}

export function broadcast(data) {
    for (const client of sseClients) {
        sendSseEvent(client.res, data);
    }
}

export async function sseHandler(req, res) {
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

    // Send initial latest sensor value
    try {
        const [rows] = await db.query('SELECT * FROM data_sensor ORDER BY time_stamp DESC LIMIT 1');
        if (rows[0]) sendSseEvent(res, { type: 'sensor', ...rows[0] });
    } catch {}

    // Send initial device states
    try {
        const [drows] = await db.execute('SELECT device_name, status FROM device');
        const mapping = { led: 0, fan: 0, spe: 0 };
        for (const r of drows) mapping[r.device_name] = r.status;
        sendSseEvent(res, { type: 'initial_state', states: mapping });
    } catch (e) {
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
}