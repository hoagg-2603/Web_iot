// server/db.js
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Đảm bảo .env được nạp
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });

const VERBOSE = (process.env.LOG_LEVEL || '').toLowerCase() === 'debug';
const logDebug = (...args) => { if (VERBOSE) console.log(...args); };

let db;

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
    logDebug('Database pool created');
} catch (error) {
    console.error('Database pool creation failed:', error);
}

export async function initDatabase() {
    if (!db) {
        console.error('Database pool is not available.');
        return;
    }
    try {
        // Chỉ thực hiện một truy vấn đơn giản để kiểm tra kết nối
        await db.query('SELECT 1');
        logDebug('Database connection test successful.');
        
    } catch (error) {
        console.error('Database connection test failed:', error);
    }
}

export { db };