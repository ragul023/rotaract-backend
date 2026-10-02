import pg from "pg";
import { env } from "../config/environment.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl:
    env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// Set schema after Neon establishes the connection
pool.on("connect", async (client) => {
  try {
    await client.query("SET search_path TO public");
  } catch (error) {
    console.error("Failed to set PostgreSQL search_path:", error);
  }
});

// Test database connection
pool
  .query(`
    SELECT
      current_database() AS database,
      current_user AS user,
      current_schema() AS schema,
      current_setting('search_path') AS search_path
  `)
  .then((result) => {
    console.log("DATABASE INFO:", result.rows[0]);
  })
  .catch((error) => {
    console.error("DATABASE CONNECTION ERROR:", error);
  });

export const query = (text, params = []) => {
  return pool.query(text, params);
};

export const withTransaction = async (callback) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await callback(client);

    await client.query("COMMIT");

    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};