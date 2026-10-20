// convex/lib/twilio.ts — send a text through Twilio's Messages API
//
// WhatsApp first, SMS as fallback: the pipeline the TontiPro app already uses
// (tontipro-app convex/otp.ts). Twilio Verify is avoided on purpose: its SMS
// channel blocked some local prefixes as anti-fraud on that account.

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  /** WhatsApp sender, e.g. "+14155238886"; omit to send SMS only */
  whatsappFrom?: string;
  /** SMS sender number or alphanumeric sender ID */
  smsFrom: string;
  fetch?: typeof fetch;
};

export type SendResult = { channel: "whatsapp" | "sms"; sid: string };

async function createMessage(config: TwilioConfig, body: Record<string, string>): Promise<string> {
  const doFetch = config.fetch ?? fetch;
  const res = await doFetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`,
      },
      body: new URLSearchParams(body).toString(),
    },
  );
  const json = (await res.json().catch(() => null)) as { sid?: string; message?: string } | null;
  if (!res.ok || !json?.sid) throw new Error(json?.message ?? `Twilio HTTP ${res.status}`);
  return json.sid;
}

/** Send `text` to `to` (E.164): WhatsApp when configured, else or on failure SMS. */
export async function sendText(config: TwilioConfig, to: string, text: string): Promise<SendResult> {
  if (config.whatsappFrom) {
    try {
      const sid = await createMessage(config, { From: `whatsapp:${config.whatsappFrom}`, To: `whatsapp:${to}`, Body: text });
      return { channel: "whatsapp", sid };
    } catch (e) {
      // Not on WhatsApp, or the sender isn't approved yet: fall back to SMS
      console.warn("WhatsApp send failed, falling back to SMS:", e instanceof Error ? e.message : e);
    }
  }
  const sid = await createMessage(config, { From: config.smsFrom, To: to, Body: text });
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
  return { accountSid, authToken, smsFrom, whatsappFrom: process.env.TWILIO_WHATSAPP_FROM || undefined };
}
