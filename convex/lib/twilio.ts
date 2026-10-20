// convex/lib/twilio.ts — send a sign-in code through Twilio's Messages API
//
// SMS by default. WhatsApp first when an approved WhatsApp template is
// configured: WhatsApp only lets a business start a conversation with a
// template, and Twilio accepts a free-form message (HTTP 201) only to fail it
// moments later (error 63016), so a free-form send can never be trusted.
// The same late failure happens for a number not on WhatsApp, so after a
// WhatsApp send the message status is checked for a few seconds and SMS takes
// over if it failed.
//
// Twilio Verify is avoided on purpose: its SMS channel blocked some local
// prefixes for the TontiPro app (tontipro-app convex/otp.ts).

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  /** SMS sender number or alphanumeric sender ID */
  smsFrom: string;
  /** WhatsApp sender and approved template (Content SID, code as variable 1); both or neither */
  whatsapp?: { from: string; contentSid: string };
  fetch?: typeof fetch;
  /** WhatsApp status checks: how many, and how far apart (default 4 × 1.5 s) */
  statusChecks?: number;
  statusIntervalMs?: number;
};

export type SendResult = { channel: "whatsapp" | "sms"; sid: string };

const FAILED_STATUSES = new Set(["failed", "undelivered", "canceled"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function twilio(
  config: TwilioConfig,
  path: string,
  form?: Record<string, string>,
): Promise<{ sid: string; status: string }> {
  const doFetch = config.fetch ?? fetch;
  const res = await doFetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}${path}`,
    {
      method: form ? "POST" : "GET",
      headers: {
        Authorization: `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    },
  );
  const json = (await res.json().catch(() => null)) as { sid?: string; status?: string; message?: string } | null;
  if (!res.ok || !json?.sid) throw new Error(json?.message ?? `Twilio HTTP ${res.status}`);
  return { sid: json.sid, status: json.status ?? "" };
}

/**
 * Wait until a message is past the point where it can fail fast. Throws if
 * Twilio reports it failed; returns once it is sent or delivered, or when the
 * checks run out (then it is treated as on its way).
 */
async function confirmNotFailed(config: TwilioConfig, sid: string) {
  const checks = config.statusChecks ?? 4;
  const interval = config.statusIntervalMs ?? 1_500;
  for (let i = 0; i < checks; i++) {
    await sleep(interval);
    const { status } = await twilio(config, `/Messages/${encodeURIComponent(sid)}.json`);
    if (FAILED_STATUSES.has(status)) throw new Error(`WhatsApp message ${status}`);
    if (status === "sent" || status === "delivered" || status === "read") return;
  }
}

/**
 * Send a sign-in code to `to` (E.164). With a WhatsApp template configured,
 * try WhatsApp first and fall back to SMS (`smsText`) if it fails; otherwise
 * send SMS only.
 */
export async function sendCode(config: TwilioConfig, to: string, code: string, smsText: string): Promise<SendResult> {
  if (config.whatsapp) {
    try {
      const { sid } = await twilio(config, "/Messages.json", {
        From: `whatsapp:${config.whatsapp.from}`,
        To: `whatsapp:${to}`,
        ContentSid: config.whatsapp.contentSid,
        ContentVariables: JSON.stringify({ "1": code }),
      });
      await confirmNotFailed(config, sid);
      return { channel: "whatsapp", sid };
    } catch (e) {
      console.warn("WhatsApp send failed, falling back to SMS:", e instanceof Error ? e.message : e);
    }
  }
  const { sid } = await twilio(config, "/Messages.json", { From: config.smsFrom, To: to, Body: smsText });
  return { channel: "sms", sid };
}

/** The sender configured from the deployment's environment variables. */
export function twilioFromEnv(): TwilioConfig {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const smsFrom = process.env.TWILIO_SMS_FROM;
  if (!accountSid || !authToken || !smsFrom) {
    throw new Error("Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_SMS_FROM with `npx convex env set`");
  }
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const contentSid = process.env.TWILIO_WHATSAPP_CONTENT_SID;
  if (Boolean(from) !== Boolean(contentSid)) {
    throw new Error("Set both TWILIO_WHATSAPP_FROM and TWILIO_WHATSAPP_CONTENT_SID, or neither (SMS only)");
  }
  return { accountSid, authToken, smsFrom, whatsapp: from && contentSid ? { from, contentSid } : undefined };
}
