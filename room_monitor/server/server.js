// server.js
import 'dotenv/config';
import express from 'express';
import mqtt from 'mqtt';
import cors from 'cors';
import pool from './db.js';

const app = express();
app.use(cors({ origin: '*' })); // cho phép gọi API từ web ngoài

// --- SSE clients ---
const clients = new Set();
app.get('/stream', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // CORS cho SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
const broadcast = obj => {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const r of clients) r.write(data);
};

// --- API lấy dữ liệu mới nhất ---
app.get('/api/latest', async (req, res) => {
  const limit = Math.min(+req.query.limit || 50, 500);
  const [rows] = await pool.query(
    'SELECT id_data,t,h,lux,time_stamp FROM Data_sensor ORDER BY id_data DESC LIMIT ?',
    [limit]
  );
  res.json(rows.reverse());
});

// --- MQTT ---
const client = mqtt.connect(process.env.MQTT_URL, { reconnectPeriod: 1000 });

client.on('connect', () => {
  console.log('MQTT connected');
  client.subscribe(process.env.MQTT_TOPIC, { qos: 0 }, (err, granted) => {
    console.log('[SUBSCRIBE]', err || granted);
  });
});

client.on('message', async (topic, payload) => {
  console.log('[MQTT<-]', topic, payload.toString());
  if (topic !== process.env.MQTT_TOPIC) return;

  const txt = payload.toString().trim();
  let t, h, lx, ts;

  // Ưu tiên JSON, fallback CSV
  try {
    ({ t, h, lx, ts } = JSON.parse(txt));
  } catch {
    const p = txt.split(',').map(s => s.trim());
    t = +p[0];
    h = +p[1];
    lx = +p[2];
    ts = Math.floor(Date.now() / 1000);
  }

  if (!Number.isFinite(t) || !Number.isFinite(h) || !Number.isFinite(lx)) {
    console.error('Bad payload:', txt);
    return;
  }

  const doc = { t, h, lx, ts, at: Date.now() };
  broadcast(doc);

  try {
    await pool.execute(
      'INSERT INTO Data_sensor(t,h,lux,time_stamp) VALUES (?,?,?,FROM_UNIXTIME(?))',
      [t, h, lx, ts]
    );
    console.log('[DB] inserted', t, h, lx, ts);
  } catch (e) {
    console.error('DB insert error:', e.message);
  }
});

// --- Start server ---
const port = process.env.PORT || 3000;
app.listen(port, () => console.log('HTTP server on', port));
