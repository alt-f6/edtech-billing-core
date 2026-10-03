/**
 * Money helpers. The ledger stores integer kopecks; payment providers send
 * decimal strings like "1500.00". Parsing is done on the string, never through
 * a float, so "0.1 + 0.2" style errors cannot reach a balance.
 */
export function parseAmountToKopecks(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid money amount: "${value}"`);
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const kopecks = whole * 100 + fraction;
  if (!Number.isSafeInteger(kopecks)) throw new Error(`Money amount out of range: "${value}"`);
  return kopecks;
}

export function formatKopecks(kopecks: number): string {
  const sign = kopecks < 0 ? "-" : "";
  const abs = Math.abs(kopecks);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
