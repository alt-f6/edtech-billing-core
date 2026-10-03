import { type Db, type Queryable, hashIp, withTransaction } from "../db.js";
import { normalizeEmail } from "./email.js";
import { type AuthenticatedUser, authenticateWithPassword } from "./password.js";

export const LOGIN_LIMITS = {
  /** Attempts allowed per (IP, email) pair inside the window. */
  perIpAndEmail: 5,
  /**
   * Attempts allowed per email across all IPs. The client controls its own
   * X-Forwarded-For header, so a per-IP limit alone is bypassed by rotating a
   * spoofed IP on every request; this cap doesn't key on IP at all. It is set
   * higher than the per-IP cap so people behind one NAT or office network
   * aren't locked out by each other's typos.
   *
   * Trade-off: anyone can lock a known email out for one window by burning
   * its attempts. That is the usual price of a per-account cap; a production
   * system pairs it with a CAPTCHA or an email unlock link.
   */
  perEmail: 20,
  windowMs: 15 * 60 * 1000,
} as const;

/**
 * Atomically checks the limits and, if the attempt is allowed, counts it.
 *
 * Check and increment happen inside one transaction holding a per-email
 * advisory lock, so a burst of parallel guesses can't all read "4 attempts so
 * far" and pass together: they queue on the lock and exactly the allowed
 * number get through. Attempts are counted *before* the password is checked;
 * a successful login then clears them.
 *
 * @returns true if the attempt may proceed
 */
export async function reserveLoginAttempt(db: Db, ip: string, email: string, now: Date = new Date()): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const ipHash = hashIp(ip);
  const windowStart = new Date(now.getTime() - LOGIN_LIMITS.windowMs);

  return withTransaction(db, async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('login:' || $1, 0))`, [normalized]);

    const { rows } = await tx.query<{ pair_attempts: number; email_attempts: number }>(
      `SELECT
         COALESCE(SUM(attempt_count) FILTER (WHERE ip_hash = $1), 0)::int AS pair_attempts,
         COALESCE(SUM(attempt_count), 0)::int                             AS email_attempts
       FROM login_attempt
       WHERE email = $2 AND last_attempt > $3`,
      [ipHash, normalized, windowStart],
    );
    const counts = rows[0] ?? { pair_attempts: 0, email_attempts: 0 };
    if (counts.pair_attempts >= LOGIN_LIMITS.perIpAndEmail || counts.email_attempts >= LOGIN_LIMITS.perEmail) {
      return false;
    }

    await tx.query(
      `INSERT INTO login_attempt AS a (ip_hash, email, attempt_count, last_attempt)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (ip_hash, email) DO UPDATE SET
         attempt_count = CASE WHEN a.last_attempt > $4 THEN a.attempt_count + 1 ELSE 1 END,
         last_attempt  = $3`,
      [ipHash, normalized, now, windowStart],
    );
    return true;
  });
}

/**
 * Clears every counter for the email, not only the caller's IP. Otherwise a
 * rotating-IP attacker's rows would keep counting against the real owner
 * after they log in successfully.
 */
export async function clearLoginAttempts(db: Queryable, email: string): Promise<void> {
  await db.query(`DELETE FROM login_attempt WHERE email = $1`, [normalizeEmail(email)]);
}

export type LoginResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; reason: "rate_limited" | "invalid_credentials" };

/** The full login flow: rate limit, enumeration-safe check, reset on success. */
export async function login(
  db: Db,
  input: { email: string; password: string; ip: string; now?: Date },
): Promise<LoginResult> {
  if (!(await reserveLoginAttempt(db, input.ip, input.email, input.now))) {
    return { ok: false, reason: "rate_limited" };
  }
  const user = await authenticateWithPassword(db, input.email, input.password);
  if (!user) return { ok: false, reason: "invalid_credentials" };
  await clearLoginAttempts(db, input.email);
  return { ok: true, user };
}

/** Deletes counters older than the window. Run periodically. */
export async function pruneLoginAttempts(db: Queryable, now: Date = new Date()): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM login_attempt WHERE last_attempt <= $1`, [
    new Date(now.getTime() - LOGIN_LIMITS.windowMs),
  ]);
  return rowCount ?? 0;
}
