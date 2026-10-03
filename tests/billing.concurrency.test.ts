import { describe, expect, it } from "vitest";
import {
  type AttendanceStatus,
  BillingRuleError,
  cancelSession,
  clearAttendance,
  getBalance,
  markAttendanceAndCharge,
} from "../src/index.js";
import { createSession, createStudent, ledgerRows, lessonNet, pauseFirst, sleep, track, useTestDb } from "./helpers.js";

const db = useTestDb();

/**
 * Two kinds of tests here:
 *  - Deterministic interleavings: one operation is paused right after taking
 *    its locks, a competing one is started, and the test asserts the second
 *    one waits. Each of these fails if the corresponding lock is removed.
 *  - Bursts: many identical or conflicting calls at once. Every call must
 *    succeed (no lost races to retry) and the ledger must come out exact.
 */
describe("locking, step by step", () => {
  it("the student lock serializes two marks for the same student", async () => {
    const student = await createStudent(db);
    const [lessonA, lessonB] = [await createSession(db), await createSession(db)];
    const gate = pauseFirst("mark");
    const log: string[] = [];

    const first = track(log, "first", markAttendanceAndCharge(db, { classSessionId: lessonA, studentId: student, status: "PRESENT" }));
    await gate.paused;
    const second = track(log, "second", markAttendanceAndCharge(db, { classSessionId: lessonB, studentId: student, status: "PRESENT" }));
    await sleep(200);

    expect(log).toEqual([]); // the second mark is waiting on the student lock
    gate.release();
    await Promise.all([first, second]);
    expect(log).toEqual(["first", "second"]);
    expect(await getBalance(db, student)).toBe(-200_000);
  });

  it("a cancellation waits for an in-flight clear, then sees its result", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db, { price: 100_000 });
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" });
    const gate = pauseFirst("clear");
    const log: string[] = [];

    const clear = track(log, "clear", clearAttendance(db, lesson, student));
    await gate.paused;
    const cancel = track(log, "cancel", cancelSession(db, lesson));
    await sleep(200);

    expect(log).toEqual([]); // cancel is blocked by the clear's share lock on the lesson
    gate.release();
    await Promise.all([clear, cancel]);

    expect(log).toEqual(["clear", "cancel"]);
    // The clear already reversed the charge, so the cancel had nothing left to reverse.
    expect((await ledgerRows(db, student)).map((r) => r.type)).toEqual(["LESSON_CHARGE", "CHARGE_REVERSAL"]);
    expect(await lessonNet(db, student, lesson)).toBe(0);
  });

  it("a clear waits for an in-flight cancellation, then refuses", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db, { price: 100_000 });
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" });
    const gate = pauseFirst("cancel");

    const cancel = cancelSession(db, lesson);
    await gate.paused;
    const clear = clearAttendance(db, lesson, student);
    await sleep(200);
    gate.release();

    expect(await cancel).toBe(1);
    await expect(clear).rejects.toBeInstanceOf(BillingRuleError);
    expect(await lessonNet(db, student, lesson)).toBe(0);
  });

  it("a mark blocked behind a cancellation does not deadlock with it", async () => {
    // The cancel writes a reversal for this student while the mark already
    // holds the student's lock. That works only because the mark takes
    // FOR NO KEY UPDATE, which doesn't block the reversal's foreign-key check.
    // With FOR UPDATE the two would deadlock.
    const student = await createStudent(db);
    const lesson = await createSession(db, { price: 100_000 });
    await markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" });
    const gate = pauseFirst("cancel");

    const cancel = cancelSession(db, lesson);
    await gate.paused;
    const mark = markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "ABSENT" });
    await sleep(200); // let the mark take the student lock and queue on the lesson
    gate.release();

    expect(await cancel).toBe(1);
    await expect(mark).rejects.toBeInstanceOf(BillingRuleError); // "cancelled", not a deadlock
    expect(await lessonNet(db, student, lesson)).toBe(0);
  });
});

describe("bursts", () => {
  it("20 simultaneous marks of the same lesson all succeed and leave exactly one charge", async () => {
    const student = await createStudent(db);
    const lesson = await createSession(db, { price: 100_000 });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" }),
      ),
    );

    expect(results.map((r) => r.rowsWritten).sort()).toEqual([...Array(19).fill(0), 1]);
    expect(await ledgerRows(db, student)).toHaveLength(1);
    expect(await getBalance(db, student)).toBe(-100_000);
  });

  it("10 lessons for one student marked at once are all charged", async () => {
    const student = await createStudent(db);
    const lessons = await Promise.all(Array.from({ length: 10 }, () => createSession(db, { price: 50_000 })));

    await Promise.all(
      lessons.map((lesson) => markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "PRESENT" })),
    );

    expect(await getBalance(db, student)).toBe(-500_000);
  });

  it("10 students on one lesson marked at once are all charged", async () => {
    const lesson = await createSession(db, { price: 70_000 });
    const students = await Promise.all(Array.from({ length: 10 }, (_, i) => createStudent(db, `s${i}`)));

    await Promise.all(
      students.map((student) => markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status: "ABSENT" })),
    );

    for (const student of students) expect(await getBalance(db, student)).toBe(-70_000);
  });

  it("conflicting marks (PRESENT vs EXCUSED) always leave the balance matching the final mark", async () => {
    const statuses: AttendanceStatus[] = ["PRESENT", "EXCUSED", "ABSENT", "EXCUSED", "PRESENT", "EXCUSED"];

    for (let round = 0; round < 10; round++) {
      const student = await createStudent(db, `round-${round}`);
      const lesson = await createSession(db, { price: 80_000 });

      await Promise.all(statuses.map((status) => markAttendanceAndCharge(db, { classSessionId: lesson, studentId: student, status })));

      const { rows } = await db.query<{ status: AttendanceStatus }>(
        `SELECT status FROM attendance WHERE class_session_id = $1 AND student_id = $2`,
        [lesson, student],
      );
      expect(await getBalance(db, student)).toBe(rows[0]!.status === "EXCUSED" ? 0 : -80_000);
    }
  });
});
