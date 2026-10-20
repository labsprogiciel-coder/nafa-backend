// convex/lib/phone.ts — phone numbers and one-time codes for saver sign-in

/**
 * Country codes Nafa sends codes to: the WAEMU countries. Anything else is
 * refused before a code is sent, which also stops SMS-pumping fraud towards
 * premium-rate destinations.
 */
export const ALLOWED_COUNTRY_CODES = ["226", "225", "221", "223", "227", "228", "229", "245"];

/**
 * True for a number in the one form the backend accepts: E.164, `+`, the
 * country code, then the national number, digits only ("+22670112233"). The
 * app formats the number; the backend never guesses a country, because the
 * stored number is the saver's sign-in identity.
 */
export function isAcceptedPhone(phone: string): boolean {
  const m = /^\+(\d{3})(\d{8,10})$/.exec(phone);
  return m !== null && ALLOWED_COUNTRY_CODES.includes(m[1]);
}

/** Minutes a sign-in code stays valid. */
export const CODE_TTL_MINUTES = 10;

/** A 6-digit code from a cryptographic source, leading zeros kept. */
export function generateCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, "0");
}

/** The French message carrying the code. */
export function codeMessage(code: string): string {
  return (
    `Votre code Nafa : ${code}\n` +
    `Il expire dans ${CODE_TTL_MINUTES} minutes. Ne le communiquez à personne, ` +
    `même à quelqu’un qui dit travailler pour Nafa.`
  );
}

/** Minimum wait between two codes to the same number. */
export const SEND_COOLDOWN_MS = 45_000;
/** Codes one number may receive in a rolling hour. */
export const SENDS_PER_HOUR = 5;

/**
 * Whether a new code may go to a number, given the times (ms) earlier codes
 * were sent to it. Returns how long to wait otherwise.
 */
export function sendAllowed(previous: number[], now: number): { ok: true } | { ok: false; retryAfterMs: number } {
  const lastHour = previous.filter((t) => t > now - 3_600_000).sort((a, b) => a - b);
  const last = lastHour[lastHour.length - 1];
  if (last !== undefined && now - last < SEND_COOLDOWN_MS) {
    return { ok: false, retryAfterMs: SEND_COOLDOWN_MS - (now - last) };
  }
  if (lastHour.length >= SENDS_PER_HOUR) {
    return { ok: false, retryAfterMs: lastHour[0] + 3_600_000 - now };
  }
  return { ok: true };
}
