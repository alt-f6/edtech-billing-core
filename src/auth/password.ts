import bcrypt from "bcryptjs";
import type { Queryable } from "../db.js";
import { normalizeEmail } from "./email.js";

export const BCRYPT_COST = 10;

export interface AuthenticatedUser {
  id: string;
  email: string;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

// Hashed once at the same cost as real hashes and cached, instead of a pasted
// bcrypt literal: one mistyped character in a hard-coded hash makes compare()
// throw instead of failing like a normal mismatch, which would reopen the very
// timing gap this exists to close.
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= bcrypt.hash("timing-normalization-placeholder", BCRYPT_COST);
  return dummyHash;
}

/** Indirection so tests can observe how many compares each path performs. */
export const passwordHasher = {
  compare: (password: string, hash: string): Promise<boolean> => bcrypt.compare(password, hash),
};

/**
 * Verifies an email and password without leaking whether the account exists.
 *
 * A naive version returns early for an unknown email and only runs bcrypt
 * (tens of milliseconds) for real accounts, so response time tells an
 * attacker which emails are registered. Here every path performs exactly one
 * bcrypt compare at the same cost, and every failure returns the same null.
 */
export async function authenticateWithPassword(
  db: Queryable,
  email: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  const { rows } = await db.query<{ id: string; email: string; password_hash: string | null; is_archived: boolean }>(
    `SELECT id, email, password_hash, is_archived FROM app_user WHERE email = $1`,
    [normalizeEmail(email)],
  );
  const user = rows[0];

  if (!user || !user.password_hash || user.is_archived) {
    await passwordHasher.compare(password, await getDummyHash());
    return null;
  }

  const valid = await passwordHasher.compare(password, user.password_hash);
  return valid ? { id: user.id, email: user.email } : null;
}
