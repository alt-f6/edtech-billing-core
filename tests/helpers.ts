import { afterAll, afterEach, beforeEach } from "vitest";
import { __testHooks } from "../src/billing/billing.service.js";
import { type Db, createPool } from "../src/db.js";

const noHook = __testHooks.afterLocks;
// Gates opened by pauseFirst(); released after every test so a failing
// assertion can't leave a paused transaction holding locks.
const openGates: Array<() => void> = [];

/** One pool per test file, with every table emptied before each test. */
export function useTestDb(): Db {
  const db = createPool();
  beforeEach(async () => {
    // TRUNCATE does not fire the ledger's row-level append-only trigger.
    await db.query(
      `TRUNCATE ledger_transaction, attendance, student_freeze, payment_intent, class_session,
                student, app_user, rate_limit_bucket, login_attempt RESTART IDENTITY CASCADE`,
    );
  });
  afterEach(() => {
    __testHooks.afterLocks = noHook;
    while (openGates.length) openGates.pop()!();
  });
  afterAll(async () => {
    await db.end();
  });
  return db;
}

export const HOUR = 60 * 60 * 1000;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createStudent(db: Db, fullName = "Test Student"): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`INSERT INTO student (full_name) VALUES ($1) RETURNING id`, [fullName]);
  return rows[0]!.id;
}

export async function createSession(
  db: Db,
  opts: { price?: number | null; isFree?: boolean; scheduledAt?: Date } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO class_session (scheduled_at, price, is_free) VALUES ($1, $2, $3) RETURNING id`,
    [opts.scheduledAt ?? new Date(Date.now() - HOUR), opts.price === undefined ? 100_000 : opts.price, opts.isFree ?? false],
  );
  return rows[0]!.id;
}

export async function ledgerRows(db: Db, studentId: string) {
  const { rows } = await db.query<{ type: string; amount: number; class_session_id: string | null }>(
    `SELECT type, amount, class_session_id FROM ledger_transaction WHERE student_id = $1 ORDER BY created_at, idempotency_key`,
    [studentId],
  );
  return rows;
}

/** Net of LESSON_CHARGE + CHARGE_REVERSAL rows for one student on one lesson. */
export async function lessonNet(db: Db, studentId: string, lessonId: string): Promise<number> {
  const { rows } = await db.query<{ net: number }>(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS net FROM ledger_transaction WHERE student_id = $1 AND class_session_id = $2`,
    [studentId, lessonId],
  );
  return rows[0]!.net;
}

/**
 * Makes the first call of `operation` pause right after taking its locks,
 * and returns controls to release it and to know when it has paused.
 */
export function pauseFirst(operation: "mark" | "clear" | "cancel") {
  let release!: () => void;
  let markPaused!: () => void;
  const released = new Promise<void>((r) => (release = r));
  openGates.push(() => release());
  const paused = new Promise<void>((r) => (markPaused = r));
  let used = false;
  __testHooks.afterLocks = async (op) => {
    if (op !== operation || used) return;
    used = true;
    markPaused();
    await released;
  };
  return { paused, release };
}

/** Records when a promise settles, relative to a shared event log. */
export function track<T>(log: string[], name: string, promise: Promise<T>): Promise<T> {
  return promise.then(
    (value) => {
      log.push(name);
      return value;
    },
    (err: unknown) => {
      log.push(name);
      throw err;
    },
  );
}
