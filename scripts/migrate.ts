import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPool } from "../src/db.js";

/**
 * Applies migrations/*.sql in filename order, each in its own transaction,
 * recording what ran in schema_migrations so re-running is a no-op.
 */
export async function migrate(connectionString = process.env.DATABASE_URL): Promise<string[]> {
  const db = createPool(connectionString);
  const applied: string[] = [];
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const dir = join(import.meta.dirname, "..", "migrations");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const done = await db.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [file]);
      if (done.rowCount) continue;
      const sql = await readFile(join(dir, file), "utf8");
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
    return applied;
  } finally {
    await db.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file
  }
  const applied = await migrate();
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
}
