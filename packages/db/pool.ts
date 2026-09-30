import pg from "pg";
import { existsSync } from "node:fs";
if (!process.env.DATABASE_URL && existsSync(".env"))
  process.loadEnvFile(".env");
export function createPool(
  connectionString = process.env.DATABASE_URL,
): pg.Pool {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return new pg.Pool({
    connectionString,
    max: 8,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 30000,
    application_name: "ticketjam-analytics",
  });
}
