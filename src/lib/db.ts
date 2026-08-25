import { Pool } from "pg";
import { loadEnvLocal } from "./env";

loadEnvLocal();

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const variable = isTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
const connectionString = process.env[variable]?.trim();

if (!connectionString) {
  // Never interpolate the value into the message: this string reaches logs.
  throw new Error(`${variable} is not set. See .env.example.`);
}
if (isTest && connectionString === process.env.DATABASE_URL?.trim()) {
  throw new Error("TEST_DATABASE_URL must not be the production database: the suite truncates it.");
}

export const pool = new Pool({ connectionString, max: 1 });

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}
