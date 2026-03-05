/**
 * Initialize database only (create tables). Use for first-time setup.
 * Run: npm run build && node dist/db/init.js
 */

import { initDatabase, getDbPath } from "./schema.js";

const dbPath = getDbPath();
const db = initDatabase(dbPath);
db.close();
console.log("Database initialized:", dbPath);
