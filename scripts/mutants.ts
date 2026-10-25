import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Mutation check: removes one defence at a time in a throwaway copy of the
 * repository and runs the test suite. A mutant "survives" if every test still
 * passes, which would mean nothing guards that line. Exits non-zero if any
 * mutant survives.
 *
 *   npm run mutants        (needs the same DATABASE_URL as `npm test`)
 */
interface Mutant {
  name: string;
  file: string;
  from: string;
  to: string;
}

const MUTANTS: Mutant[] = [
  { name: "no student lock", file: "src/billing/billing.service.ts", from: "WHERE id = $1 FOR NO KEY UPDATE`", to: "WHERE id = $1`" },
  { name: "no lesson share lock", file: "src/billing/billing.service.ts", from: "FROM class_session WHERE id = $1 FOR SHARE`", to: "FROM class_session WHERE id = $1`" },
  { name: "FOR UPDATE instead of FOR NO KEY UPDATE", file: "src/billing/billing.service.ts", from: "FOR NO KEY UPDATE`", to: "FOR UPDATE`" },
  { name: "clear ignores cancellation", file: "src/billing/billing.service.ts", from: 'if (session.is_cancelled) throw new BillingRuleError("Cannot clear attendance for a cancelled lesson");', to: "" },
  { name: "a charge can be reversed twice", file: "migrations/002_reversal_reference.sql", from: "  ADD CONSTRAINT ledger_charge_reversed_once UNIQUE (reverses_id);", to: "  ADD CONSTRAINT ledger_charge_reversed_once CHECK (true);" },
  { name: "reversal need not match its charge", file: "migrations/002_reversal_reference.sql", from: "  IF NEW.reverses_id IS NULL THEN", to: "  IF TRUE THEN" },
  { name: "lost reversal race not mapped", file: "src/billing/billing.service.ts", from: 'pgErrorConstraint(err) === "ledger_charge_reversed_once"', to: "false" },
  { name: "price snapshot ignored", file: "src/billing/billing.service.ts", from: "const price = snapshot && snapshot > 0 ? snapshot : (session.price ?? 0);", to: "const price = session.price ?? 0; void snapshot;" },
  { name: "no payment idempotency", file: "src/payments/webhook.handler.ts", from: "ON CONFLICT (idempotency_key) DO NOTHING", to: "" },
  { name: "provider payment id not matched", file: "src/payments/webhook.handler.ts", from: "if (!payment || payment.id !== paymentId) return", to: "if (!payment) return" },
  { name: "no intent amount check", file: "src/payments/webhook.handler.ts", from: 'if (intentRow && intentRow.amount !== amount) return { status: 422, outcome: "invalid_payment" };', to: "" },
  { name: "no zero-amount guard", file: "src/payments/webhook.handler.ts", from: "if (amount <= 0 || payment.amount.currency", to: "if (payment.amount.currency" },
  { name: "no dummy bcrypt compare", file: "src/auth/password.ts", from: "    await passwordHasher.compare(password, await getDummyHash());", to: "" },
  { name: "no login advisory lock", file: "src/auth/login-rate-limit.ts", from: "await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('login:' || $1, 0))`, [normalized]);", to: "" },
  { name: "no email normalization", file: "src/auth/email.ts", from: "return email.trim().toLowerCase();", to: "return email;" },
];

const root = join(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "mutants-"));
for (const entry of ["src", "tests", "scripts", "migrations", "package.json", "tsconfig.json", "vitest.config.ts", ".env"]) {
  try {
    cpSync(join(root, entry), join(work, entry), { recursive: true });
  } catch {
    // .env is optional
  }
}
// A junction needs no admin rights on Windows; the type is ignored elsewhere.
symlinkSync(join(root, "node_modules"), join(work, "node_modules"), "junction");

let survivors = 0;
try {
  for (const mutant of MUTANTS) {
    const path = join(work, mutant.file);
    const original = readFileSync(path, "utf8");
    if (!original.includes(mutant.from)) throw new Error(`Mutant "${mutant.name}": pattern not found in ${mutant.file}`);
    writeFileSync(path, original.replace(mutant.from, mutant.to));

    // npx is npx.cmd on Windows, which only runs through a shell.
    const run = spawnSync("npx", ["vitest", "run", "--testTimeout=8000"], {
      cwd: work,
      encoding: "utf8",
      timeout: 300_000,
      shell: process.platform === "win32",
    });
    writeFileSync(path, original);

    // A suite that never ran also exits non-zero. Count a mutant as killed
    // only when the tests actually ran and some of them failed.
    const summary = /Tests\s+([^\n]+)/.exec(run.stdout ?? "")?.[1]?.trim();
    if (!summary) {
      throw new Error(`Mutant "${mutant.name}": the test suite did not run\n${run.error ?? run.stderr ?? ""}`);
    }
    const killed = run.status !== 0;
    if (!killed) survivors++;
    console.log(`${killed ? "killed  " : "SURVIVED"}  ${mutant.name.padEnd(42)} ${summary}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${MUTANTS.length - survivors}/${MUTANTS.length} mutants killed`);
process.exit(survivors === 0 ? 0 : 1);