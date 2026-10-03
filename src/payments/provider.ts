/**
 * The slice of a payment provider the webhook needs. The handler depends on
 * this interface, not on a concrete client, so tests use an in-memory fake and
 * production uses the HTTP client below.
 */
export interface ProviderPayment {
  id: string;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  paid: boolean;
  amount: { value: string; currency: string };
  metadata?: Record<string, string>;
}

export interface PaymentProvider {
  /** Returns the provider's raw response; the webhook validates its shape. */
  fetchPayment(paymentId: string): Promise<unknown>;
}

const STATUSES = new Set(["pending", "waiting_for_capture", "succeeded", "canceled"]);

/**
 * Runtime validation of a provider response. A type assertion would let a
 * changed or broken API response reach the ledger as `undefined` fields;
 * this rejects it instead.
 */
export function parseProviderPayment(raw: unknown): ProviderPayment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const amount = p["amount"] as Record<string, unknown> | undefined;
  const metadata = p["metadata"];
  if (
    typeof p["id"] !== "string" ||
    typeof p["status"] !== "string" ||
    !STATUSES.has(p["status"]) ||
    typeof p["paid"] !== "boolean" ||
    typeof amount !== "object" ||
    amount === null ||
    typeof amount["value"] !== "string" ||
    typeof amount["currency"] !== "string"
  ) {
    return null;
  }
  const payment: ProviderPayment = {
    id: p["id"],
    status: p["status"] as ProviderPayment["status"],
    paid: p["paid"],
    amount: { value: amount["value"], currency: amount["currency"] },
  };
  if (typeof metadata === "object" && metadata !== null) {
    payment.metadata = Object.fromEntries(
      Object.entries(metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
  return payment;
}

/** Minimal YooKassa REST client: only what payment verification needs. */
export class YooKassaClient implements PaymentProvider {
  constructor(
    private readonly shopId: string,
    private readonly secretKey: string,
    private readonly baseUrl = "https://api.yookassa.ru/v3",
  ) {}

  async fetchPayment(paymentId: string): Promise<unknown> {
    const auth = Buffer.from(`${this.shopId}:${this.secretKey}`).toString("base64");
    const response = await fetch(`${this.baseUrl}/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Payment lookup failed with HTTP ${response.status}`);
    return response.json();
  }
}
