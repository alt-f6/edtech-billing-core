/** One canonical form for every place an email is stored or compared. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
