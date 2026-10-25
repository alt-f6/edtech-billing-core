import { describe, expect, it } from "vitest";
import {
  type AttendanceStatus,
  BillingRuleError,
  cancelSession,
  clearAttendance,
  creditPayment,
  markAttendanceAndCharge,
} from "../src/index.js";
import { createSession, createStudent, useTestDb } from "./helpers.js";

const db = useTestDb();

/** Small seeded PRNG so a failing sequence can be replayed exactly. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Invariants that must hold after ANY sequence of operations. Each query
 * returns the rows that violate it; an empty result means it holds.
 */
const INVARIANTS: Record<string, string> = {
  "a lesson's net is either 0 or minus its snapshotted price": `
    SELECT t.student_id, t.class_session_id FROM ledger_transaction t
    LEFT JOIN attendance a ON a.class_session_id = t.class_session_id AND a.student_id = t.student_id
    WHERE t.class_session_id IS NOT NULL
    GROUP BY t.student_id, t.class_session_id, a.price_at_time
    HAVING SUM(t.amount) NOT IN (0, -COALESCE(a.price_at_time, 0))`,

  "a billable mark on a priced, active, unfrozen lesson nets to minus its price": `
    SELECT a.id FROM attendance a JOIN class_session s ON s.id = a.class_session_id
    WHERE a.status IN ('PRESENT', 'ABSENT') AND NOT s.is_free AND NOT s.is_cancelled
      AND NOT EXISTS (SELECT 1 FROM student_freeze f WHERE f.student_id = a.student_id
                      AND (s.scheduled_at AT TIME ZONE 'UTC')::date BETWEEN f.start_date AND f.end_date)
      AND COALESCE((SELECT SUM(amount) FROM ledger_transaction t
                    WHERE t.class_session_id = a.class_session_id AND t.student_id = a.student_id), 0) <> -a.price_at_time`,

  "an unmarked or excused lesson nets to zero": `
    SELECT a.id FROM attendance a
    WHERE (a.status IS NULL OR a.status = 'EXCUSED')
      AND COALESCE((SELECT SUM(amount) FROM ledger_transaction t
                    WHERE t.class_session_id = a.class_session_id AND t.student_id = a.student_id), 0) <> 0`,

  "a lesson inside the student's freeze nets to zero": `
    SELECT t.student_id FROM ledger_transaction t JOIN class_session s ON s.id = t.class_session_id
    WHERE EXISTS (SELECT 1 FROM student_freeze f WHERE f.student_id = t.student_id
                  AND (s.scheduled_at AT TIME ZONE 'UTC')::date BETWEEN f.start_date AND f.end_date)
    GROUP BY t.student_id, t.class_session_id HAVING SUM(t.amount) <> 0`,

  "a free lesson never nets to a charge": `
    SELECT t.student_id FROM ledger_transaction t JOIN class_session s ON s.id = t.class_session_id
    WHERE s.is_free GROUP BY t.student_id, t.class_session_id HAVING SUM(t.amount) <> 0`,

  "a cancelled lesson nets to zero for every student": `
    SELECT t.student_id FROM ledger_transaction t JOIN class_session s ON s.id = t.class_session_id
    WHERE s.is_cancelled GROUP BY t.student_id, t.class_session_id HAVING SUM(t.amount) <> 0`,

  "a lesson's reversals never exceed its charges": `
    SELECT student_id FROM ledger_transaction WHERE class_session_id IS NOT NULL
    GROUP BY student_id, class_session_id HAVING SUM(amount) > 0`,

  "a lesson has at most one charge that no reversal names": `
    SELECT c.student_id FROM ledger_transaction c
    WHERE c.type = 'LESSON_CHARGE'
      AND NOT EXISTS (SELECT 1 FROM ledger_transaction r WHERE r.reverses_id = c.id)
    GROUP BY c.student_id, c.class_session_id HAVING COUNT(*) > 1`,

  "each provider payment is credited at most once": `
    SELECT idempotency_key FROM ledger_transaction WHERE type = 'PAYMENT'
    GROUP BY 1 HAVING COUNT(*) > 1`,
};

async function assertInvariants() {
  for (const [name, sql] of Object.entries(INVARIANTS)) {
    const { rows } = await db.query(sql);
    expect(rows, `invariant violated: ${name}`).toEqual([]);
  }
}

describe("ledger invariants under random operation sequences", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("seed %i: 200 random operations, five at a time in parallel", async (seed) => {
    const rand = prng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

    const students = await Promise.all(Array.from({ length: 4 }, (_, i) => createStudent(db, `s${i}`)));
    const lessons = await Promise.all(
      Array.from({ length: 10 }, () => createSession(db, { price: pick([50_000, 75_000, 100_000]), isFree: rand() < 0.15 })),
    );
    // One student is on a billing freeze covering every lesson's date.
    await db.query(
      `INSERT INTO student_freeze (student_id, start_date, end_date)
       VALUES ($1, (now() AT TIME ZONE 'UTC')::date - 1, (now() AT TIME ZONE 'UTC')::date + 1)`,
      [students[0]],
    );
    const statuses: AttendanceStatus[] = ["PRESENT", "ABSENT", "EXCUSED"];
    let paymentSeq = 0;
    let succeeded = 0;
    let previousRows = 0;

    const operation = () => {
      const roll = rand();
      const student = pick(students);
      const lesson = pick(lessons);
      if (roll < 0.55) return markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: pick(statuses) });
      if (roll < 0.77) return clearAttendance(db, lesson, student);
      if (roll < 0.8) return cancelSession(db, lesson);
      // Sometimes redeliver an earlier payment id, to exercise idempotency.
      const id = rand() < 0.3 && paymentSeq > 0 ? `p${Math.ceil(rand() * paymentSeq)}` : `p${++paymentSeq}`;
      return creditPayment(db, { providerPaymentId: `${seed}-${id}`, studentId: student, amount: 100_000 });
    };

    for (let batch = 0; batch < 40; batch++) {
      const settled = await Promise.allSettled(Array.from({ length: 5 }, operation));
      for (const result of settled) {
        if (result.status === "fulfilled") succeeded++;
        // The only acceptable refusal is touching a lesson that has been
        // cancelled. A lost race, a deadlock or any other error fails the test.
        else {
          expect(result.reason).toBeInstanceOf(BillingRuleError);
          expect((result.reason as Error).message).toMatch(/cancelled lesson/);
        }
      }
      await assertInvariants();

      // Append-only: the ledger never shrinks.
      const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ledger_transaction`);
      expect(rows[0]!.n).toBeGreaterThanOrEqual(previousRows);
      previousRows = rows[0]!.n;
    }

    // Guard against a vacuous pass: the bulk of the operations really ran.
    expect(succeeded).toBeGreaterThan(100);
  });
});
