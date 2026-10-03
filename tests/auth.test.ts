import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOGIN_LIMITS,
  authenticateWithPassword,
  checkRateLimit,
  hashIp,
  hashPassword,
  login,
  passwordHasher,
  pruneLoginAttempts,
  pruneRateLimits,
  reserveLoginAttempt,
} from "../src/index.js";
import { useTestDb } from "./helpers.js";

const db = useTestDb();

async function createUser(email: string, password: string, archived = false) {
  await db.query(`INSERT INTO app_user (email, password_hash, is_archived) VALUES ($1, $2, $3)`, [
    email,
    await hashPassword(password),
    archived,
  ]);
}

describe("authenticateWithPassword", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the user for correct credentials, case-insensitively on email", async () => {
    await createUser("teacher@example.com", "correct horse");
    expect((await authenticateWithPassword(db, "  Teacher@Example.com ", "correct horse"))?.email).toBe("teacher@example.com");
  });

  it("returns the same null for a wrong password, an unknown email and an archived account", async () => {
    await createUser("a@example.com", "pw-a");
    await createUser("gone@example.com", "pw-gone", true);
    expect(await authenticateWithPassword(db, "a@example.com", "wrong")).toBeNull();
    expect(await authenticateWithPassword(db, "nobody@example.com", "whatever")).toBeNull();
    expect(await authenticateWithPassword(db, "gone@example.com", "pw-gone")).toBeNull();
  });

  it.each([
    ["an existing account with a wrong password", "real@example.com"],
    ["an unknown email", "missing@example.com"],
  ])("runs exactly one bcrypt compare for %s", async (_label, email) => {
    await createUser("real@example.com", "pw");
    const compare = vi.spyOn(passwordHasher, "compare");
    await authenticateWithPassword(db, email, "wrong");
    // Same work on every path, so response time doesn't reveal which emails exist.
    expect(compare).toHaveBeenCalledTimes(1);
  });
});

describe("login rate limiting", () => {
  it("allows exactly 5 of 50 simultaneous guesses from one IP", async () => {
    await createUser("victim@example.com", "secret");
    const results = await Promise.all(
      Array.from({ length: 50 }, () => login(db, { email: "victim@example.com", password: "guess", ip: "1.1.1.1" })),
    );
    expect(results.filter((r) => !r.ok && r.reason === "invalid_credentials")).toHaveLength(LOGIN_LIMITS.perIpAndEmail);
    expect(results.filter((r) => !r.ok && r.reason === "rate_limited")).toHaveLength(50 - LOGIN_LIMITS.perIpAndEmail);
  });

  it("can't be dodged by changing the email's letter case or padding", async () => {
    const variants = ["victim@example.com", "Victim@Example.com", " VICTIM@example.com ", "victim@EXAMPLE.com", "vIcTiM@example.com"];
    for (const email of variants) expect(await reserveLoginAttempt(db, "1.1.1.1", email)).toBe(true);
    expect(await reserveLoginAttempt(db, "1.1.1.1", "VICTIM@EXAMPLE.COM")).toBe(false);
  });

  it("still locks the email when an attacker rotates spoofed IPs", async () => {
    for (let i = 0; i < LOGIN_LIMITS.perEmail; i++) {
      expect(await reserveLoginAttempt(db, `10.0.0.${i}`, "victim@example.com")).toBe(true);
    }
    expect(await reserveLoginAttempt(db, "10.9.9.9", "victim@example.com")).toBe(false);
  });

  it("forgets attempts once the window has passed", async () => {
    const past = new Date(Date.now() - LOGIN_LIMITS.windowMs - 1000);
    for (let i = 0; i < LOGIN_LIMITS.perIpAndEmail; i++) await reserveLoginAttempt(db, "1.1.1.1", "a@example.com", past);
    expect(await reserveLoginAttempt(db, "1.1.1.1", "a@example.com")).toBe(true);
  });

  it("a successful login clears the email's attempts from every IP", async () => {
    await createUser("a@example.com", "pw");
    await login(db, { email: "a@example.com", password: "bad", ip: "1.1.1.1" });
    await login(db, { email: "a@example.com", password: "bad", ip: "2.2.2.2" });
    expect((await login(db, { email: "A@example.com", password: "pw", ip: "3.3.3.3" })).ok).toBe(true);
    const { rowCount } = await db.query(`SELECT 1 FROM login_attempt`);
    expect(rowCount).toBe(0);
  });

  it("stores keyed hashes of IPs, never raw addresses or plain SHA-256", async () => {
    await reserveLoginAttempt(db, "198.51.100.23", "a@example.com");
    const { rows } = await db.query<{ ip_hash: string }>(`SELECT ip_hash FROM login_attempt`);
    const stored = rows[0]!.ip_hash;
    expect(stored).toMatch(/^[0-9a-f]{32}$/);
    expect(stored).toBe(hashIp("198.51.100.23"));
    // Without the server key, hashing every IPv4 address doesn't reproduce it.
    expect(stored).not.toBe(createHash("sha256").update("198.51.100.23").digest("hex").slice(0, 32));
    expect(hashIp("198.51.100.23", "another-key")).not.toBe(stored);
  });

  it("prunes counters older than the window", async () => {
    await reserveLoginAttempt(db, "1.1.1.1", "old@example.com", new Date(Date.now() - LOGIN_LIMITS.windowMs - 1000));
    await reserveLoginAttempt(db, "1.1.1.1", "new@example.com");
    expect(await pruneLoginAttempts(db)).toBe(1);
  });
});

describe("checkRateLimit", () => {
  it("lets exactly `limit` of 100 simultaneous requests through", async () => {
    const results = await Promise.all(Array.from({ length: 100 }, () => checkRateLimit(db, "burst", 10, 60_000)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it("opens a fresh window after the old one expires, and prunes expired buckets", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    expect((await checkRateLimit(db, "k", 1, 1000, t0)).allowed).toBe(true);
    expect((await checkRateLimit(db, "k", 1, 1000, new Date(t0.getTime() + 500))).allowed).toBe(false);
    expect((await checkRateLimit(db, "k", 1, 1000, new Date(t0.getTime() + 1500))).allowed).toBe(true);
    expect(await pruneRateLimits(db, new Date(t0.getTime() + 5000))).toBe(1);
  });
});
