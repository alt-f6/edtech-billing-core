import pg from "pg";
import { migrate } from "../scripts/migrate.js";

/** Rebuilds the schema from migrations once per test run. */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Start Postgres with `docker compose up -d --wait` and copy .env.example to .env.");
  }
  // The setup drops the whole public schema. Refuse anything that doesn't
  // look like a throwaway test database.
  const dbName = new URL(url).pathname.slice(1);
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to wipe database "${dbName}": the test database name must contain "test".`);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await client.end();
  await migrate(url);
}
