/** A request that breaks a business rule. Safe to show to the operator. */
export class BillingRuleError extends Error {
  override readonly name = "BillingRuleError";
}

export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}

/**
 * Another transaction changed the same student's ledger first. Nothing was
 * written; the caller may re-read and retry, or surface "try again".
 */
export class ConcurrentUpdateError extends Error {
  override readonly name = "ConcurrentUpdateError";
  constructor(options?: { cause?: unknown }) {
    super("The record was modified concurrently; nothing was written", options);
  }
}
