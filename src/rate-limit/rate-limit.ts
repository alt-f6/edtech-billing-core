import type { Queryable } from "../db.js";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

/**
 * Fixed-window rate limiter backed by Postgres.
 *
 * The whole read-modify-write is one INSERT ... ON CONFLICT DO UPDATE, so it is
 * atomic under concurrency: 100 parallel requests against a limit of 10 let
 * exactly 10 through. State lives in the database, so limits survive restarts
 * and are shared by every app instance (an in-memory Map is neither).
 *
 * `now` is injectable for tests; in production pass nothing. Instances should
 * keep their clocks in sync (NTP), as with any time-windowed limiter.
 */
export async function checkRateLimit(
  db: Queryable,
  key: string,
  limit: number,
  windowMs: number,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const freshResetAt = new Date(now.getTime() + windowMs);
  const { rows } = await db.query<{ count: number; reset_at: Date }>(
    `INSERT INTO rate_limit_bucket AS b (key, count, reset_at)
     VALUES ($1, 1, $2)
     ON CONFLICT (key) DO UPDATE SET
       count    = CASE WHEN b.reset_at <= $3 THEN 1  ELSE b.count + 1 END,
       reset_at = CASE WHEN b.reset_at <= $3 THEN $2 ELSE b.reset_at END
     RETURNING count, reset_at`,
    [key, freshResetAt, now],
  );
  const row = rows[0]!;
  return { allowed: row.count <= limit, remaining: Math.max(0, limit - row.count), resetAt: row.reset_at };
}

/** Deletes expired buckets. Run periodically (e.g. from a cron job). */
export async function pruneRateLimits(db: Queryable, now: Date = new Date()): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM rate_limit_bucket WHERE reset_at <= $1`, [now]);
  return rowCount ?? 0;
}
