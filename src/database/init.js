import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./connection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

async function initDatabase() {
  try {
    await pool.query(schemaSql);
    console.log("Database schema initialized successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Failed to initialize database schema:", error.message);
    process.exit(1);
  }
}

initDatabase();
