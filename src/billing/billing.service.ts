import { type Db, type Tx, PgError, pgErrorCode, withTransaction } from "../db.js";
import { BillingRuleError, ConcurrentUpdateError, NotFoundError } from "../errors.js";

export type AttendanceStatus = "PRESENT" | "ABSENT" | "EXCUSED";

export interface MarkAttendanceInput {
  classSessionId: string;
  studentId: string;
  status: AttendanceStatus;
  /** IANA zone the school's calendar (freezes) is defined in. Default UTC. */
  timeZone?: string;
  /** Injected for tests; defaults to the wall clock. */
  now?: Date;
}

export interface MarkAttendanceResult {
  status: AttendanceStatus;
  /** Net amount this lesson now costs the student, in signed kopecks (0 = no charge). */
  lessonNet: number;
  reason: "charged" | "not_billable" | "frozen" | "free";
  /** Ledger rows appended by this call (0 when the net was already right). */
  rowsWritten: number;
}

/**
 * Pause points for deterministic concurrency tests: a test makes one
 * operation stop right after it has taken its locks, starts a competing
 * operation, and checks that the second one waits. No-ops in normal use.
 */
export const __testHooks = {
  afterLocks: async (_operation: "mark" | "clear" | "cancel"): Promise<void> => {},
};

const isBillable = (status: AttendanceStatus | null): status is "PRESENT" | "ABSENT" =>
  status === "PRESENT" || status === "ABSENT";

/**
 * Marks attendance and brings the ledger in line with it.
 *
 * The ledger is append-only. Each (student, lesson) pair has a "net": the sum
 * of its LESSON_CHARGE and CHARGE_REVERSAL rows, always either 0 or minus the
 * snapshotted price. Re-marking never edits history: if the net must change,
 * the old charge is reversed with a new row and, if needed, a new charge is
 * appended. Re-marking to the same outcome writes nothing.
 *
 * Locking (see "Locking" in the README):
 *   1. the student row, FOR NO KEY UPDATE: one writer per student at a time,
 *      so concurrent marks are applied one after another, never interleaved;
 *   2. the lesson row, FOR SHARE: marks on the same lesson coexist, but a
 *      cancellation (FOR UPDATE) waits for them and they wait for it.
 * Every operation takes the student before the lesson, and the ledger's
 * foreign-key checks only need KEY SHARE, which NO KEY UPDATE does not block,
 * so the lock graph has no cycles. Plain READ COMMITTED is enough: after
 * waiting for a lock, each statement reads the committed state.
 */
export async function markAttendanceAndCharge(db: Db, input: MarkAttendanceInput): Promise<MarkAttendanceResult> {
  const { classSessionId, studentId, status } = input;
  const now = input.now ?? new Date();
  const timeZone = input.timeZone ?? "UTC";
  if (!isValidTimeZone(timeZone)) throw new BillingRuleError(`Unknown time zone: ${timeZone}`);

  return inTransaction(db, async (tx) => {
    await lockStudent(tx, studentId);
    const session = await lockSessionShared(tx, classSessionId);

    if (session.is_cancelled) throw new BillingRuleError("Cannot mark attendance for a cancelled lesson");
    if (isBillable(status) && now < session.scheduled_at) {
      throw new BillingRuleError("Cannot mark attendance before the lesson starts");
    }

    const existing = await tx.query<{ price_at_time: number }>(
      `SELECT price_at_time FROM attendance WHERE class_session_id = $1 AND student_id = $2`,
      [classSessionId, studentId],
    );
    // The first mark snapshots the lesson price; later re-marks reuse it.
    const snapshot = existing.rows[0]?.price_at_time;
    const price = snapshot && snapshot > 0 ? snapshot : (session.price ?? 0);

    const frozen = isBillable(status) && (await hasActiveFreeze(tx, studentId, session.scheduled_at, timeZone));

    // Zero-price guard: a billable, unfrozen lesson that is not explicitly
    // free must never silently cost 0. That almost always means a missing
    // price, not a gift. is_free is the only sanctioned way to charge nothing.
    if (isBillable(status) && !frozen && !session.is_free && price === 0) {
      throw new BillingRuleError("Lesson has no price; mark it as free explicitly to charge nothing");
    }

    const target = isBillable(status) && !frozen && !session.is_free ? -price : 0;
    const ledger = await lessonLedger(tx, studentId, classSessionId);
    await __testHooks.afterLocks("mark");

    await tx.query(
      `INSERT INTO attendance (class_session_id, student_id, status, price_at_time)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (class_session_id, student_id)
       DO UPDATE SET status = EXCLUDED.status, price_at_time = EXCLUDED.price_at_time`,
      [classSessionId, studentId, status, price],
    );
    const rowsWritten = await moveLessonNet(tx, { studentId, classSessionId, ledger, target, why: `marked ${status}` });

    const reason = !isBillable(status) ? "not_billable" : frozen ? "frozen" : session.is_free ? "free" : "charged";
    return { status, lessonNet: target, reason, rowsWritten };
  });
}

/**
 * Reverts a mark to "unmarked" and reverses the lesson's charge, if any.
 * Refused for a cancelled lesson, whose charge was already reversed by the
 * cancellation: reversing it again would credit the student twice.
 */
export async function clearAttendance(db: Db, classSessionId: string, studentId: string): Promise<void> {
  await inTransaction(db, async (tx) => {
    await lockStudent(tx, studentId);
    const session = await lockSessionShared(tx, classSessionId);
    if (session.is_cancelled) throw new BillingRuleError("Cannot clear attendance for a cancelled lesson");

    const ledger = await lessonLedger(tx, studentId, classSessionId);
    await __testHooks.afterLocks("clear");

    await tx.query(`UPDATE attendance SET status = NULL WHERE class_session_id = $1 AND student_id = $2`, [
      classSessionId,
      studentId,
    ]);
    await moveLessonNet(tx, { studentId, classSessionId, ledger, target: 0, why: "mark cleared" });
  });
}

/**
 * Cancels a lesson and reverses every student's outstanding charge for it.
 * Idempotent: cancelling an already-cancelled lesson writes nothing.
 *
 * @returns the number of students whose charge was reversed
 */
export async function cancelSession(db: Db, classSessionId: string): Promise<number> {
  return inTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ is_cancelled: boolean }>(
      `SELECT is_cancelled FROM class_session WHERE id = $1 FOR UPDATE`,
      [classSessionId],
    );
    const session = rows[0];
    if (!session) throw new NotFoundError(`Lesson ${classSessionId} not found`);
    if (session.is_cancelled) return 0;
    await __testHooks.afterLocks("cancel");

    // Read after taking the lesson lock: every mark or clear that held the
    // lesson's share lock has committed by now, so these nets are final.
    const outstanding = await tx.query<{ student_id: string; net: number; rows: number }>(
      `SELECT student_id, SUM(amount)::bigint AS net, COUNT(*)::int AS rows
       FROM ledger_transaction WHERE class_session_id = $1
       GROUP BY student_id HAVING SUM(amount) <> 0
       ORDER BY student_id`,
      [classSessionId],
    );
    for (const row of outstanding.rows) {
      await moveLessonNet(tx, {
        studentId: row.student_id,
        classSessionId,
        ledger: { net: row.net, rows: row.rows },
        target: 0,
        why: "lesson cancelled",
      });
    }

    await tx.query(`UPDATE class_session SET is_cancelled = TRUE WHERE id = $1`, [classSessionId]);
    return outstanding.rows.length;
  });
}

/** Balance in kopecks: the sum of every ledger row. Negative = owes money. */
export async function getBalance(db: Db | Tx, studentId: string): Promise<number> {
  const { rows } = await db.query<{ balance: number }>(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS balance FROM ledger_transaction WHERE student_id = $1`,
    [studentId],
  );
  return rows[0]?.balance ?? 0;
}

// ─── internals ────────────────────────────────────────────────

interface SessionRow {
  scheduled_at: Date;
  price: number | null;
  is_free: boolean;
  is_cancelled: boolean;
}

interface LessonLedger {
  net: number;
  rows: number;
}

async function inTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(db, fn);
  } catch (err) {
    // The lock order is designed to be deadlock-free; this mapping is a safety
    // net so an unexpected lost race still surfaces as a typed, retryable error.
    const code = pgErrorCode(err);
    if (code === PgError.deadlockDetected || code === PgError.serializationFailure) {
      throw new ConcurrentUpdateError({ cause: err });
    }
    throw err;
  }
}

async function lockStudent(tx: Tx, studentId: string): Promise<void> {
  const { rowCount } = await tx.query(`SELECT 1 FROM student WHERE id = $1 FOR NO KEY UPDATE`, [studentId]);
  if (!rowCount) throw new NotFoundError(`Student ${studentId} not found`);
}

async function lockSessionShared(tx: Tx, classSessionId: string): Promise<SessionRow> {
  const { rows } = await tx.query<SessionRow>(
    `SELECT scheduled_at, price, is_free, is_cancelled FROM class_session WHERE id = $1 FOR SHARE`,
    [classSessionId],
  );
  const session = rows[0];
  if (!session) throw new NotFoundError(`Lesson ${classSessionId} not found`);
  return session;
}

async function lessonLedger(tx: Tx, studentId: string, classSessionId: string): Promise<LessonLedger> {
  const { rows } = await tx.query<LessonLedger>(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS net, COUNT(*)::int AS rows
     FROM ledger_transaction WHERE student_id = $1 AND class_session_id = $2`,
    [studentId, classSessionId],
  );
  return rows[0] ?? { net: 0, rows: 0 };
}

/**
 * Appends the rows that take a lesson's net from its current value to
 * `target`: a reversal of the outstanding charge, then the new charge.
 * Idempotency keys are numbered per lesson under the student lock, so they are
 * deterministic, and a replayed write collides on the UNIQUE key instead of
 * being applied twice.
 */
async function moveLessonNet(
  tx: Tx,
  p: { studentId: string; classSessionId: string; ledger: LessonLedger; target: number; why: string },
): Promise<number> {
  if (p.ledger.net === p.target) return 0;
  let seq = p.ledger.rows;
  const append = (type: "LESSON_CHARGE" | "CHARGE_REVERSAL", amount: number, description: string) =>
    tx.query(
      `INSERT INTO ledger_transaction (student_id, class_session_id, amount, type, description, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [p.studentId, p.classSessionId, amount, type, description, `lesson:${p.classSessionId}:${p.studentId}:${++seq}`],
    );

  let written = 0;
  if (p.ledger.net !== 0) {
    await append("CHARGE_REVERSAL", -p.ledger.net, `Reversal: ${p.why}`);
    written++;
  }
  if (p.target !== 0) {
    await append("LESSON_CHARGE", p.target, "Lesson charge");
    written++;
  }
  return written;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** A freeze covering the lesson's calendar day in the school's time zone, last day included. */
async function hasActiveFreeze(tx: Tx, studentId: string, scheduledAt: Date, timeZone: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `SELECT 1 FROM student_freeze
     WHERE student_id = $1
       AND ($2::timestamptz AT TIME ZONE $3)::date BETWEEN start_date AND end_date
     LIMIT 1`,
    [studentId, scheduledAt, timeZone],
  );
  return (rowCount ?? 0) > 0;
}
