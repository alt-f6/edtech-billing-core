import { describe, expect, it } from "vitest";
import {
  BillingRuleError,
  cancelSession,
  clearAttendance,
  getBalance,
  markAttendanceAndCharge,
} from "../src/index.js";
import { HOUR, createSession, createStudent, ledgerRows, lessonNet, useTestDb } from "./helpers.js";

const db = useTestDb();

describe("markAttendanceAndCharge: business rules", () => {
  it("charges the lesson price once for PRESENT", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db, { price: 150_000 });

    const result = await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" });

    expect(result).toEqual({ status: "PRESENT", lessonNet: -150_000, reason: "charged", rowsWritten: 1 });
    expect(await getBalance(db, student)).toBe(-150_000);
  });

  it("charges for ABSENT too: a missed lesson is still billed", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db, { price: 90_000 });
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "ABSENT" });
    expect(await getBalance(db, student)).toBe(-90_000);
  });

  it("re-marking to the same outcome writes nothing", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db);
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" });

    // PRESENT -> ABSENT costs the same, so the ledger is already right.
    const again = await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "ABSENT" });

    expect(again.rowsWritten).toBe(0);
    expect(await ledgerRows(db, student)).toHaveLength(1);
  });

  it("corrections append reversal rows; history is never edited", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db, { price: 100_000 });

    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" });
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "EXCUSED" });
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" });

    expect((await ledgerRows(db, student)).map((r) => [r.type, r.amount])).toEqual([
      ["LESSON_CHARGE", -100_000],
      ["CHARGE_REVERSAL", 100_000],
      ["LESSON_CHARGE", -100_000],
    ]);
    expect(await getBalance(db, student)).toBe(-100_000);
  });

  it("keeps the price snapshotted at the first mark when the lesson price changes later", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db, { price: 100_000 });
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" });
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "EXCUSED" });

    await db.query(`UPDATE class_session SET price = 250000 WHERE id = $1`, [lesson]);
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" });

    expect(await lessonNet(db, student, lesson)).toBe(-100_000);
  });

  it("does not charge a lesson explicitly marked free", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db, { price: 0, isFree: true });
    const result = await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" });
    expect(result.reason).toBe("free");
    expect(await ledgerRows(db, student)).toEqual([]);
  });

  it("refuses to silently charge 0 for a lesson with no price that isn't marked free", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db, { price: null });

    await expect(
      markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" }),
    ).rejects.toBeInstanceOf(BillingRuleError);
    const { rowCount } = await db.query(`SELECT 1 FROM attendance WHERE student_id = $1`, [student]);
    expect(rowCount).toBe(0); // the whole transaction rolled back
  });

  it("does not charge during a freeze, including the freeze's last day", async () => {
    const student = await createStudent(db);
    const scheduledAt = new Date("2026-03-10T15:00:00Z");
    const lesson = await createSession(db, { scheduledAt });
    await db.query(`INSERT INTO student_freeze (student_id, start_date, end_date) VALUES ($1, '2026-03-01', '2026-03-10')`, [student]);

    const result = await markAttendanceAndCharge(db, {
      classSessionId: lesson,
      studentId: student,
      status: "PRESENT",
      now: new Date("2026-03-10T16:00:00Z"),
    });

    expect(result.reason).toBe("frozen");
    expect(await getBalance(db, student)).toBe(0);
  });

  it("evaluates freezes in the school's time zone, not UTC", async () => {
    const student = await createStudent(db);
    // 01:00 on 11 March in Yekaterinburg (UTC+5) is still 10 March in UTC.
    const lesson = await createSession(db, { scheduledAt: new Date("2026-03-10T20:00:00Z") });
    await db.query(`INSERT INTO student_freeze (student_id, start_date, end_date) VALUES ($1, '2026-03-11', '2026-03-20')`, [student]);
    const mark = (timeZone: string) =>
      markAttendanceAndCharge(db, {
        classSessionId: lesson,
        studentId: student,
        status: "PRESENT",
        timeZone,
        now: new Date("2026-03-10T21:00:00Z"),
      });

    expect((await mark("UTC")).reason).toBe("charged");
    expect((await mark("Asia/Yekaterinburg")).reason).toBe("frozen");
  });

  it("rejects an unknown time zone as a rule error, not a raw database error", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db);
    await expect(
      markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT", timeZone: "Mars/Olympus" }),
    ).rejects.toBeInstanceOf(BillingRuleError);
  });

  it("refuses to bill a lesson before it starts", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db, { scheduledAt: new Date(Date.now() + 2 * HOUR) });
    await expect(
      markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" }),
    ).rejects.toThrow(/before the lesson starts/);
  });
});

describe("clearAttendance", () => {
  it("un-marks the lesson and reverses its charge", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db);
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" });

    await clearAttendance(db, lesson, student);

    const { rows } = await db.query(`SELECT status FROM attendance WHERE student_id = $1`, [student]);
    expect(rows[0]?.status).toBeNull();
    expect((await ledgerRows(db, student)).map((r) => r.type)).toEqual(["LESSON_CHARGE", "CHARGE_REVERSAL"]);
    expect(await getBalance(db, student)).toBe(0);
  });

  it("is a no-op for a student who was never marked", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db);
    await clearAttendance(db, lesson, student);
    const { rowCount } = await db.query(`SELECT 1 FROM attendance WHERE student_id = $1`, [student]);
    expect(rowCount).toBe(0);
    expect(await ledgerRows(db, student)).toEqual([]);
  });
});

describe("cancelSession", () => {
  it("reverses every student's charge and keeps both rows in the ledger", async () => {
    const [a, b] = [await createStudent(db, "A"), await createStudent(db, "B")];
    const lesson = await createSession(db, { price: 120_000 });
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: a, status: "PRESENT" });
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: b, status: "ABSENT" });

    expect(await cancelSession(db, lesson)).toBe(2);

    for (const student of [a, b]) {
      expect((await ledgerRows(db, student)).map((r) => r.type)).toEqual(["LESSON_CHARGE", "CHARGE_REVERSAL"]);
      expect(await getBalance(db, student)).toBe(0);
    }
  });

  it("is idempotent: cancelling twice never refunds twice", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db);
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" });

    await cancelSession(db, lesson);
    expect(await cancelSession(db, lesson)).toBe(0);
    expect(await getBalance(db, student)).toBe(0);
  });

  it("blocks marking attendance on a cancelled lesson", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db);
    await cancelSession(db, lesson);
    await expect(
      markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" }),
    ).rejects.toThrow(/cancelled/);
  });

  // Regression, found by the randomized invariant test: clearing a cancelled
  // lesson used to remove the original charge while its refund stayed, so the
  // student was credited for a lesson they were never charged for.
  it("refuses to clear a cancelled lesson, which would refund the student twice", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db, { price: 100_000 });
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" });
    await cancelSession(db, lesson);

    await expect(clearAttendance(db, lesson, student)).rejects.toBeInstanceOf(BillingRuleError);
    expect(await getBalance(db, student)).toBe(0);
  });
});

describe("the ledger itself", () => {
  it("refuses BIGINTs beyond 2^53 instead of silently rounding them", async () => {
    await expect(db.query(`SELECT 9007199254740993::bigint AS n`)).rejects.toThrow(/out of safe range/);
    const { rows } = await db.query<{ n: number }>(`SELECT 9007199254740991::bigint AS n`);
    expect(rows[0]!.n).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects UPDATE and DELETE at the database level", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db);
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" });

    await expect(db.query(`UPDATE ledger_transaction SET amount = -1`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM ledger_transaction`)).rejects.toThrow(/append-only/);
  });

  it("rejects rows whose sign contradicts their type", async () => {
    const student = await createStudent(db);
    await expect(
      db.query(
        `INSERT INTO ledger_transaction (student_id, amount, type, description, idempotency_key)
         VALUES ($1, -500, 'PAYMENT', 'x', 'k1')`,
        [student],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
