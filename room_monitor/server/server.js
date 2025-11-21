// server/server.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Import các mô-đun đã tách
import { db, initDatabase } from './db.js';
import { initMqtt, mqttClient } from './mqtt.js';
import { sseHandler } from './sse.js';
import apiRoutes from './routes.js';

// Load .env (db.js load)
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
// Serve static files từ thư mục gốc (nơi có index.html)
app.use(express.static(path.join(__dirname, '..')));

// Gắn các API routes
app.use('/api', apiRoutes);

// Gắn SSE route
app.get('/stream', sseHandler);

// Serve trang chủ
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../index.html'));
});

// Hàm khởi động server
async function startServer() {
    try {
        await initDatabase();
        initMqtt(); 
        
        app.listen(PORT, () => {
            console.log('Server running')
            
        });
    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
}

// shutdown
process.on('SIGINT', async () => {
    if (mqttClient) mqttClient.end();
    if (db) await db.end();
    process.exit(0);
});

startServer();