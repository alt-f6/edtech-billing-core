import { describe, expect, it } from "vitest";
import { ConcurrentUpdateError, cancelSession, clearAttendance, markAttendanceAndCharge } from "../src/index.js";
import { createSession, createStudent, lessonNet, pauseFirst, useTestDb } from "./helpers.js";

const db = useTestDb();

async function lessonRows(studentId: string, lessonId: string) {
  const { rows } = await db.query<{ id: string; type: string; amount: number; reverses_id: string | null }>(
    `SELECT id, type, amount, reverses_id FROM ledger_transaction
     WHERE student_id = $1 AND class_session_id = $2 ORDER BY created_at, idempotency_key`,
    [studentId, lessonId],
  );
  return rows;
}

/** A reversal written straight to the table, the way a careless future code path might. */
function insertReversal(p: { studentId: string; lessonId: string; amount: number; reversesId: string | null; key: string }) {
  return db.query(
    `INSERT INTO ledger_transaction (student_id, class_session_id, amount, type, description, idempotency_key, reverses_id)
     VALUES ($1, $2, $3, 'CHARGE_REVERSAL', 'manual', $4, $5)`,
    [p.studentId, p.lessonId, p.amount, p.key, p.reversesId],
  );
}

async function chargedLesson() {
  const studentId = await createStudent(db);
  const lessonId = await createSession(db, { price: 50_000 });
  await markAttendanceAndCharge(db, { classSessionId: lessonId, studentId, status: "PRESENT" });
  const [charge] = await lessonRows(studentId, lessonId);
  return { studentId, lessonId, charge: charge! };
}

describe("each reversal names the charge it reverses", () => {
  it("clearing writes a reversal that points at the charge", async () => {
    const { studentId, lessonId, charge } = await chargedLesson();
    await clearAttendance(db, lessonId, studentId);

    const rows = await lessonRows(studentId, lessonId);
    expect(rows.map((r) => [r.type, r.amount, r.reverses_id])).toEqual([
      ["LESSON_CHARGE", -50_000, null],
      ["CHARGE_REVERSAL", 50_000, charge.id],
    ]);
  });

  it("re-marking and cancelling reverse each charge once, newest charge last", async () => {
    const { studentId, lessonId } = await chargedLesson();
    await markAttendanceAndCharge(db, { classSessionId: lessonId, studentId, status: "EXCUSED" });
    await markAttendanceAndCharge(db, { classSessionId: lessonId, studentId, status: "ABSENT" });
    await cancelSession(db, lessonId);

    const rows = await lessonRows(studentId, lessonId);
    const charges = rows.filter((r) => r.type === "LESSON_CHARGE").map((r) => r.id);
    const reversed = rows.filter((r) => r.type === "CHARGE_REVERSAL").map((r) => r.reverses_id);
    expect(charges).toHaveLength(2);
    expect(reversed).toEqual(charges);
    expect(await lessonNet(db, studentId, lessonId)).toBe(0);
  });
});

describe("the schema refuses a bad reversal, whichever code path writes it", () => {
  it("refuses a second reversal of the same charge", async () => {
    const { studentId, lessonId, charge } = await chargedLesson();
    await cancelSession(db, lessonId);

    await expect(
      insertReversal({ studentId, lessonId, amount: 50_000, reversesId: charge.id, key: "manual:1" }),
    ).rejects.toMatchObject({ code: "23505", constraint: "ledger_charge_reversed_once" });
    expect(await lessonNet(db, studentId, lessonId)).toBe(0);
  });

  it("refuses a reversal that names no charge", async () => {
    const { studentId, lessonId } = await chargedLesson();
    await expect(
      insertReversal({ studentId, lessonId, amount: 50_000, reversesId: null, key: "manual:1" }),
    ).rejects.toMatchObject({ code: "23514", constraint: "ledger_reversal_names_charge" });
  });

  it("refuses a reversal for a different amount, student or lesson than its charge", async () => {
    const { studentId, lessonId, charge } = await chargedLesson();
    const otherStudent = await createStudent(db, "other");
    const otherLesson = await createSession(db, { price: 50_000 });

    for (const [i, bad] of [
      { studentId, lessonId, amount: 100_000 },
      { studentId: otherStudent, lessonId, amount: 50_000 },
      { studentId, lessonId: otherLesson, amount: 50_000 },
    ].entries()) {
      await expect(insertReversal({ ...bad, reversesId: charge.id, key: `manual:${i}` })).rejects.toThrow(
        /does not match charge/,
      );
    }
  });

  it("a path that reads the ledger, then loses the race, gets an error instead of a double refund", async () => {
    const { studentId, lessonId, charge } = await chargedLesson();
    // The clear has taken its locks and read the open charge. Another path
    // that ignores the lock order reverses that charge and commits first.
    const gate = pauseFirst("clear");
    const clear = clearAttendance(db, lessonId, studentId);
    await gate.paused;
    await insertReversal({ studentId, lessonId, amount: 50_000, reversesId: charge.id, key: "other-path:1" });
    gate.release();

    await expect(clear).rejects.toBeInstanceOf(ConcurrentUpdateError);
    expect(await lessonNet(db, studentId, lessonId)).toBe(0);
  });
});
