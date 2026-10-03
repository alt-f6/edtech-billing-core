import { type Db, hashIp, withTransaction } from "../db.js";
import { parseAmountToKopecks } from "../money.js";
import { checkRateLimit } from "../rate-limit/rate-limit.js";
import { type PaymentProvider, parseProviderPayment } from "./provider.js";
import { extractProvidedSecret, isProviderIp, secretMatches } from "./webhook-auth.js";

export interface WebhookConfig {
  /** Shared secret configured in the provider's webhook URL. */
  webhookSecret: string | undefined;
  /** True when talking to the real provider (not a local mock). */
  livePayments: boolean;
  /** Escape hatch for proxies that hide the client IP. Off by default. */
  skipIpCheck?: boolean;
  /** Currency the shop bills in; anything else is rejected. */
  currency: string;
  rateLimit?: { max: number; windowMs: number };
}

export interface WebhookRequest {
  /** Absolute or path-only request URL. */
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
  clientIp: string;
}

export type WebhookOutcome =
  | "rate_limited"
  | "misconfigured_no_secret"
  | "secret_mismatch"
  | "ip_rejected"
  | "invalid_json"
  | "missing_payment_id"
  | "verification_failed"
  | "canceled"
  | "ignored_status"
  | "invalid_payment"
  | "unresolvable_student"
  | "credited"
  | "duplicate_ignored";

export interface WebhookResponse {
  status: number;
  outcome: WebhookOutcome;
}

const DEFAULT_RATE_LIMIT = { max: 60, windowMs: 60_000 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Payment webhook, written so that nothing in the request body is trusted.
 *
 * The body only tells us *which* payment changed. Everything that moves money
 * (status, amount, currency, owner) is re-read from the provider's API and
 * checked against the payment intent we created, so a forged or replayed
 * notification can at worst trigger a no-op lookup. Layers, cheapest first:
 *
 *   1. rate limit per source IP (Postgres-backed, survives restarts)
 *   2. shared secret, compared in constant time; mandatory in live mode
 *   3. provider IP allowlist (live mode)
 *   4. server-side re-verification of the payment via the provider API,
 *      with the response validated at runtime
 *   5. consistency with our intent: same owner, same amount, same currency
 *   6. idempotent credit: one ledger row per provider payment id, enforced by
 *      a UNIQUE key, so a redelivered webhook is a no-op
 *
 * Every input maps to a status code; nothing a caller sends can make it throw.
 * Framework-agnostic: takes a plain request object and returns a status, so
 * the same function backs a Next.js route, Express, or a test.
 */
export async function handlePaymentWebhook(
  deps: { db: Db; provider: PaymentProvider; config: WebhookConfig },
  request: WebhookRequest,
): Promise<WebhookResponse> {
  const { db, provider, config } = deps;
  const limits = config.rateLimit ?? DEFAULT_RATE_LIMIT;

  const rate = await checkRateLimit(db, `payment-webhook:${hashIp(request.clientIp)}`, limits.max, limits.windowMs);
  if (!rate.allowed) return { status: 429, outcome: "rate_limited" };

  // Once real payments are on, the secret is mandatory. It must never silently
  // degrade to "IP allowlist only": the client IP comes from a forwarding
  // header and is spoofable behind a misconfigured proxy.
  if (config.livePayments && !config.webhookSecret) return { status: 500, outcome: "misconfigured_no_secret" };
  if (config.webhookSecret) {
    const provided = extractProvidedSecret(request.url, request.headers["authorization"]);
    if (!secretMatches(provided, config.webhookSecret)) return { status: 401, outcome: "secret_mismatch" };
  }
  if (config.livePayments && !config.skipIpCheck && !isProviderIp(request.clientIp)) {
    return { status: 403, outcome: "ip_rejected" };
  }

  let paymentId: string | undefined;
  try {
    const parsed = JSON.parse(request.body) as { object?: { id?: unknown } } | null;
    paymentId = typeof parsed?.object?.id === "string" ? parsed.object.id : undefined;
  } catch {
    return { status: 400, outcome: "invalid_json" };
  }
  if (!paymentId) return { status: 400, outcome: "missing_payment_id" };

  // 5xx makes the provider redeliver later: right when its API or our
  // network is briefly down, or when it answers with something unexpected.
  let raw: unknown;
  try {
    raw = await provider.fetchPayment(paymentId);
  } catch {
    return { status: 502, outcome: "verification_failed" };
  }
  const payment = parseProviderPayment(raw);
  if (!payment || payment.id !== paymentId) return { status: 502, outcome: "verification_failed" };

  const intentRow = (
    await db.query<{ student_id: string; amount: number }>(
      `SELECT student_id, amount FROM payment_intent WHERE provider_id = $1`,
      [payment.id],
    )
  ).rows[0];

  if (payment.status === "canceled") {
    await db.query(`UPDATE payment_intent SET status = 'CANCELED' WHERE provider_id = $1 AND status = 'PENDING'`, [
      payment.id,
    ]);
    return { status: 200, outcome: "canceled" };
  }
  if (payment.status !== "succeeded" || !payment.paid) return { status: 200, outcome: "ignored_status" };

  // From here on the payment is real money. Anything inconsistent is a 422:
  // logged for a human, not retried, never credited.
  let amount: number;
  try {
    amount = parseAmountToKopecks(payment.amount.value);
  } catch {
    return { status: 422, outcome: "invalid_payment" };
  }
  if (amount <= 0 || payment.amount.currency !== config.currency) return { status: 422, outcome: "invalid_payment" };
  if (intentRow && intentRow.amount !== amount) return { status: 422, outcome: "invalid_payment" };

  // The owner is our own intent's student. Without an intent, fall back to
  // the metadata we attached when creating the payment, read back from the
  // provider (never from the notification body).
  const metadataStudent = payment.metadata?.["studentId"];
  if (intentRow && metadataStudent && metadataStudent !== intentRow.student_id) {
    return { status: 422, outcome: "invalid_payment" };
  }
  const studentId = intentRow?.student_id ?? metadataStudent;
  if (!studentId || !UUID.test(studentId)) return { status: 422, outcome: "unresolvable_student" };
  const known = await db.query(`SELECT 1 FROM student WHERE id = $1`, [studentId]);
  if (!known.rowCount) return { status: 422, outcome: "unresolvable_student" };

  const credited = await creditPayment(db, { providerPaymentId: payment.id, studentId, amount });
  return { status: 200, outcome: credited ? "credited" : "duplicate_ignored" };
}

/**
 * Credits a verified payment exactly once. The provider's payment id is the
 * ledger idempotency key; ON CONFLICT DO NOTHING turns a duplicate delivery
 * into a no-op without aborting the transaction.
 *
 * @returns true if this call wrote the credit, false if it already existed
 */
export async function creditPayment(
  db: Db,
  input: { providerPaymentId: string; studentId: string; amount: number },
): Promise<boolean> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new RangeError(`Payment amount must be a positive integer of kopecks, got ${input.amount}`);
  }
  return withTransaction(db, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO ledger_transaction (student_id, amount, type, description, idempotency_key)
       VALUES ($1, $2, 'PAYMENT', 'Online payment', $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [input.studentId, input.amount, `payment:${input.providerPaymentId}`],
    );
    if (inserted.rowCount === 0) return false;

    // Money arrived, so the intent succeeded, even if it had been marked
    // cancelled (e.g. the "canceled" and "succeeded" events raced).
    await tx.query(`UPDATE payment_intent SET status = 'SUCCEEDED' WHERE provider_id = $1`, [input.providerPaymentId]);
    return true;
  });
}
