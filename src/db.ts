import { createHmac } from "node:crypto";
import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = Db | Tx;

// BIGINT columns hold kopecks. Parse them as JS numbers, scoped to this
// library's pools (not the process-wide pg default), and refuse any value
// beyond Number.MAX_SAFE_INTEGER instead of silently losing precision.
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === pg.types.builtins.INT8) {
      return (value: string) => {
        const n = Number(value);
        if (!Number.isSafeInteger(n)) throw new RangeError(`BIGINT out of safe range: ${value}`);
        return n;
      };
    }
    return format === "binary" ? pg.types.getTypeParser(oid, "binary") : pg.types.getTypeParser(oid, "text");
  },
} as pg.CustomTypesConfig;

export function createPool(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString, max: 20, types });
}

/** Postgres SQLSTATEs the services map to typed errors. */
export const PgError = {
  serializationFailure: "40001",
  deadlockDetected: "40P01",
} as const;

export function pgErrorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/**
 * Runs `fn` inside one READ COMMITTED transaction on one pooled connection.
 * Commits on success; on error rolls back and rethrows the original error so
 * callers can inspect its SQLSTATE. A connection whose ROLLBACK failed is
 * destroyed rather than returned to the pool in an unknown state.
 */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr: Error) => {
      broken = rollbackErr;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}

/**
 * Keyed hash (HMAC-SHA-256) used wherever a client IP would otherwise be
 * stored. A plain SHA-256 of an IPv4 address is reversible by hashing all
 * 2^32 addresses; without the server-side key that isn't possible.
 */
export function hashIp(ip: string, key = process.env.IP_HASH_KEY): string {
  if (!key) throw new Error("IP_HASH_KEY is not set");
  return createHmac("sha256", key).update(ip.trim().toLowerCase()).digest("hex").slice(0, 32);
}
