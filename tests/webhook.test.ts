import { describe, expect, it } from "vitest";
import {
  type PaymentProvider,
  type WebhookConfig,
  type WebhookRequest,
  getBalance,
  handlePaymentWebhook,
  isProviderIp,
} from "../src/index.js";
import { createStudent, ledgerRows, useTestDb } from "./helpers.js";

const db = useTestDb();

const SECRET = "whsec_test_9f2c1a";
const PROVIDER_IP = "185.71.76.10";

/** In-memory provider: the "truth" the webhook must verify against. */
class FakeProvider implements PaymentProvider {
  payments = new Map<string, unknown>();
  failNext = false;
  async fetchPayment(id: string): Promise<unknown> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("provider unavailable");
    }
    if (!this.payments.has(id)) throw new Error("not found");
    return structuredClone(this.payments.get(id));
  }
  edit(id: string, patch: Record<string, unknown>) {
    this.payments.set(id, { ...(this.payments.get(id) as object), ...patch });
  }
}

const liveConfig: WebhookConfig = { webhookSecret: SECRET, livePayments: true, currency: "RUB" };

function request(body: unknown, opts: { secret?: string | null; ip?: string; rawBody?: string; url?: string } = {}): WebhookRequest {
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  return {
    url: opts.url ?? `https://api.example.com/webhooks/payments${secret ? `?secret=${secret}` : ""}`,
    headers: {},
    body: opts.rawBody ?? JSON.stringify(body),
    clientIp: opts.ip ?? PROVIDER_IP,
  };
}

async function setup(opts: { amount?: string; intent?: boolean } = {}) {
  const provider = new FakeProvider();
  const student = await createStudent(db);
  if (opts.intent !== false) {
    await db.query(`INSERT INTO payment_intent (student_id, provider_id, amount) VALUES ($1, 'pay_1', 150000)`, [student]);
  }
  provider.payments.set("pay_1", {
    id: "pay_1",
    status: "succeeded",
    paid: true,
    amount: { value: opts.amount ?? "1500.00", currency: "RUB" },
    metadata: { studentId: student },
  });
  return { provider, student, deps: { db, provider, config: liveConfig } };
}

const notification = { event: "payment.succeeded", object: { id: "pay_1" } };

describe("payment webhook: authentication", () => {
  it("rejects a request without the shared secret", async () => {
    const { deps, student } = await setup();
    expect(await handlePaymentWebhook(deps, request(notification, { secret: null }))).toEqual({ status: 401, outcome: "secret_mismatch" });
    expect(await getBalance(db, student)).toBe(0);
  });

  it("rejects a wrong secret of the same length", async () => {
    const { deps } = await setup();
    const forged = "x".repeat(SECRET.length);
    expect((await handlePaymentWebhook(deps, request(notification, { secret: forged }))).status).toBe(401);
  });

  it("accepts the secret as Basic-auth credentials", async () => {
    const { deps } = await setup();
    const req = request(notification, { secret: null });
    req.headers["authorization"] = `Basic ${Buffer.from(`shop:${SECRET}`).toString("base64")}`;
    expect((await handlePaymentWebhook(deps, req)).outcome).toBe("credited");
  });

  it("works with a path-only request URL, as Express provides", async () => {
    const { deps } = await setup();
    const res = await handlePaymentWebhook(deps, request(notification, { url: `/webhooks/payments?secret=${SECRET}` }));
    expect(res.outcome).toBe("credited");
  });

  it("answers 401, not a crash, for a request target URL that can't be parsed", async () => {
    const { deps } = await setup();
    for (const url of ["//[x", "//a:b@[::1/?secret=s"]) {
      expect(await handlePaymentWebhook(deps, request(notification, { url }))).toEqual({ status: 401, outcome: "secret_mismatch" });
    }
  });

  it("rejects a valid secret from an IP outside the provider's ranges", async () => {
    const { deps } = await setup();
    expect(await handlePaymentWebhook(deps, request(notification, { ip: "203.0.113.7" }))).toEqual({ status: 403, outcome: "ip_rejected" });
  });

  it("skips only the IP check when told to (proxy hides the client IP); the secret still applies", async () => {
    const { provider } = await setup();
    const config = { ...liveConfig, skipIpCheck: true };
    expect((await handlePaymentWebhook({ db, provider, config }, request(notification, { ip: "10.0.0.5" }))).outcome).toBe("credited");
    expect((await handlePaymentWebhook({ db, provider, config }, request(notification, { ip: "10.0.0.5", secret: null }))).status).toBe(401);
  });

  it("refuses to run unauthenticated in live mode when the secret is not configured", async () => {
    const { provider } = await setup();
    const res = await handlePaymentWebhook({ db, provider, config: { ...liveConfig, webhookSecret: undefined } }, request(notification));
    expect(res).toEqual({ status: 500, outcome: "misconfigured_no_secret" });
  });

  it("rate-limits a flood from one source", async () => {
    const { provider } = await setup();
    const config = { ...liveConfig, rateLimit: { max: 3, windowMs: 60_000 } };
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await handlePaymentWebhook({ db, provider, config }, request(notification))).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });
});

describe("payment webhook: nothing in the body is trusted", () => {
  it("credits the amount verified with the provider, not anything in the notification", async () => {
    const { deps, student } = await setup();
    const tampered = { ...notification, object: { id: "pay_1", amount: { value: "999999.00", currency: "RUB" } } };
    expect((await handlePaymentWebhook(deps, request(tampered))).outcome).toBe("credited");
    expect(await getBalance(db, student)).toBe(150_000);
  });

  it("ignores 'succeeded' for a payment the provider says is still pending", async () => {
    const { deps, provider, student } = await setup();
    provider.edit("pay_1", { status: "pending", paid: false });
    expect((await handlePaymentWebhook(deps, request(notification))).outcome).toBe("ignored_status");
    expect(await getBalance(db, student)).toBe(0);
  });

  it("marks the intent cancelled when the provider reports a cancellation", async () => {
    const { deps, provider } = await setup();
    provider.edit("pay_1", { status: "canceled", paid: false });
    expect((await handlePaymentWebhook(deps, request(notification))).outcome).toBe("canceled");
    const { rows } = await db.query(`SELECT status FROM payment_intent WHERE provider_id = 'pay_1'`);
    expect(rows[0]?.status).toBe("CANCELED");
  });

  it.each([
    ["an unexpected currency", { amount: { value: "1500.00", currency: "USD" } }],
    ["a zero amount", { amount: { value: "0.00", currency: "RUB" } }],
    ["an amount different from our payment intent", { amount: { value: "1499.99", currency: "RUB" } }],
    ["an unparseable amount", { amount: { value: "15e2", currency: "RUB" } }],
  ])("rejects a payment with %s and credits nothing", async (_label, patch) => {
    const { deps, provider, student } = await setup();
    provider.edit("pay_1", patch);
    expect(await handlePaymentWebhook(deps, request(notification))).toEqual({ status: 422, outcome: "invalid_payment" });
    expect(await getBalance(db, student)).toBe(0);
  });

  it("rejects a zero amount even without an intent to compare against", async () => {
    const { deps, provider, student } = await setup({ intent: false });
    provider.edit("pay_1", { amount: { value: "0.00", currency: "RUB" } });
    expect(await handlePaymentWebhook(deps, request(notification))).toEqual({ status: 422, outcome: "invalid_payment" });
    expect(await getBalance(db, student)).toBe(0);
  });

  it("rejects provider metadata that names a different student than our intent", async () => {
    const { deps, provider, student } = await setup();
    const other = await createStudent(db, "Other");
    provider.edit("pay_1", { metadata: { studentId: other } });
    expect((await handlePaymentWebhook(deps, request(notification))).status).toBe(422);
    expect(await getBalance(db, student)).toBe(0);
    expect(await getBalance(db, other)).toBe(0);
  });

  it("falls back to provider metadata when there is no intent, and validates it", async () => {
    const { deps, provider, student } = await setup({ intent: false });
    expect((await handlePaymentWebhook(deps, request(notification))).outcome).toBe("credited");
    expect(await getBalance(db, student)).toBe(150_000);

    provider.payments.set("pay_2", { id: "pay_2", status: "succeeded", paid: true, amount: { value: "10.00", currency: "RUB" }, metadata: { studentId: "not-a-uuid" } });
    const res = await handlePaymentWebhook(deps, request({ object: { id: "pay_2" } }));
    expect(res).toEqual({ status: 422, outcome: "unresolvable_student" });
  });

  it("treats a malformed provider response as a failed verification (502, retried later)", async () => {
    const { deps, provider, student } = await setup();
    provider.payments.set("pay_1", { id: "pay_1", status: "succeeded", paid: true }); // no amount
    expect((await handlePaymentWebhook(deps, request(notification))).outcome).toBe("verification_failed");
    provider.payments.set("pay_1", { id: "pay_other", status: "succeeded", paid: true, amount: { value: "1500.00", currency: "RUB" } });
    expect((await handlePaymentWebhook(deps, request(notification))).outcome).toBe("verification_failed");
    expect(await getBalance(db, student)).toBe(0);
  });

  it("returns 502 when the provider is down, so it redelivers; the redelivery credits once", async () => {
    const { deps, provider, student } = await setup();
    provider.failNext = true;
    expect((await handlePaymentWebhook(deps, request(notification))).status).toBe(502);
    expect((await handlePaymentWebhook(deps, request(notification))).outcome).toBe("credited");
    expect(await getBalance(db, student)).toBe(150_000);
  });

  it("returns 400 for malformed JSON, a null body or a missing payment id", async () => {
    const { deps } = await setup();
    expect((await handlePaymentWebhook(deps, request(null, { rawBody: "{not json" }))).status).toBe(400);
    expect((await handlePaymentWebhook(deps, request(null, { rawBody: "null" }))).status).toBe(400);
    expect((await handlePaymentWebhook(deps, request({ event: "payment.succeeded" }))).status).toBe(400);
  });
});

describe("payment webhook: idempotency", () => {
  it("credits a redelivered notification exactly once", async () => {
    const { deps, student } = await setup();
    expect((await handlePaymentWebhook(deps, request(notification))).outcome).toBe("credited");
    expect(await handlePaymentWebhook(deps, request(notification))).toEqual({ status: 200, outcome: "duplicate_ignored" });
    expect(await getBalance(db, student)).toBe(150_000);
  });

  it("credits exactly once when 10 identical deliveries arrive at the same moment", async () => {
    const { deps, student } = await setup();
    const results = await Promise.all(Array.from({ length: 10 }, () => handlePaymentWebhook(deps, request(notification))));
    expect(results.filter((r) => r.outcome === "credited")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "duplicate_ignored")).toHaveLength(9);
    expect(await ledgerRows(db, student)).toHaveLength(1);
    expect(await getBalance(db, student)).toBe(150_000);
  });

  it("a success arriving after a cancellation still credits and fixes the intent's status", async () => {
    const { deps, provider, student } = await setup();
    provider.edit("pay_1", { status: "canceled", paid: false });
    await handlePaymentWebhook(deps, request(notification));
    provider.edit("pay_1", { status: "succeeded", paid: true });
    expect((await handlePaymentWebhook(deps, request(notification))).outcome).toBe("credited");
    const { rows } = await db.query(`SELECT status FROM payment_intent WHERE provider_id = 'pay_1'`);
    expect(rows[0]?.status).toBe("SUCCEEDED");
    expect(await getBalance(db, student)).toBe(150_000);
  });
});

describe("isProviderIp", () => {
  it.each([
    ["185.71.76.0", true],
    ["185.71.76.31", true],
    ["185.71.76.32", false],
    ["77.75.156.11", true],
    ["77.75.156.12", false],
    ["::ffff:185.71.77.5", true],
    ["2a02:5180::1", true],
    ["2a02:5180:zzzz::1", false],
    ["2a02:5181::1", false],
    ["10.0.0.1", false],
    ["185.71.76.999", false],
    ["not-an-ip", false],
  ])("%s -> %s", (ip, expected) => {
    expect(isProviderIp(ip)).toBe(expected);
  });
});
