import { BlockList, isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";

/**
 * Source ranges the provider documents for its webhook notifications.
 * https://yookassa.ru/developers/using-api/webhooks#ip
 * Checked with node:net's BlockList, which parses both address families
 * properly instead of comparing string prefixes.
 */
const providerRanges = new BlockList();
providerRanges.addSubnet("185.71.76.0", 27, "ipv4");
providerRanges.addSubnet("185.71.77.0", 27, "ipv4");
providerRanges.addSubnet("77.75.153.0", 25, "ipv4");
providerRanges.addAddress("77.75.156.11", "ipv4");
providerRanges.addAddress("77.75.156.35", "ipv4");
providerRanges.addSubnet("77.75.154.128", 25, "ipv4");
providerRanges.addSubnet("2a02:5180::", 32, "ipv6");

export function isProviderIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  const family = isIP(normalized);
  if (family === 0) return false;
  return providerRanges.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Extracts the shared secret the provider sends: as Basic-auth credentials
 * embedded in the webhook URL (preferred: kept out of access logs), or as a
 * `secret` query parameter. Accepts absolute or path-only URLs, so it works
 * with frameworks whose request URL is relative (Express's req.url).
 */
export function extractProvidedSecret(url: string, authorization: string | undefined): string | null {
  if (authorization?.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator !== -1 && separator < decoded.length - 1) return decoded.slice(separator + 1);
  }
  try {
    return new URL(url, "http://localhost").searchParams.get("secret");
  } catch {
    return null; // unparseable request target: treated as "no secret", so 401
  }
}

/** Constant-time comparison: response time doesn't reveal how much matched. */
export function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
