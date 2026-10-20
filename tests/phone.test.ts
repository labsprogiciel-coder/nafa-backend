import { describe, expect, test } from "vitest";
import { codeMessage, generateCode, isAcceptedPhone, SEND_COOLDOWN_MS, sendAllowed } from "../convex/lib/phone";
import { sendText } from "../convex/lib/twilio";

describe("isAcceptedPhone", () => {
  test("accepts E.164 numbers from WAEMU countries", () => {
    for (const p of ["+22670112233", "+2250707070707", "+221771234567", "+22990123456"]) {
      expect(isAcceptedPhone(p)).toBe(true);
    }
  });

  test("refuses other countries and anything not in E.164", () => {
    for (const p of ["+33612345678", "+14155550100", "70112233", "0022670112233", "+226 70 11 22 33", "+2267011", "+226701122334455"]) {
      expect(isAcceptedPhone(p)).toBe(false);
    }
  });
});

describe("codes", () => {
  test("are 6 digits, leading zeros kept", () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });

  test("the message carries the code and its expiry", () => {
    const m = codeMessage("042517");
    expect(m).toContain("042517");
    expect(m).toContain("10 minutes");
  });
});

describe("sendAllowed", () => {
  const now = 10_000_000;

  test("allows a first code", () => {
    expect(sendAllowed([], now)).toEqual({ ok: true });
  });

  test("makes the next code wait out the cooldown", () => {
    expect(sendAllowed([now - 10_000], now)).toEqual({ ok: false, retryAfterMs: SEND_COOLDOWN_MS - 10_000 });
    expect(sendAllowed([now - SEND_COOLDOWN_MS], now)).toEqual({ ok: true });
  });

  test("caps codes per rolling hour", () => {
    const five = [50, 40, 30, 20, 10].map((m) => now - m * 60_000);
    expect(sendAllowed(five, now)).toEqual({ ok: false, retryAfterMs: 10 * 60_000 });
    expect(sendAllowed(five.slice(1).concat(now - 61 * 60_000), now)).toEqual({ ok: true });
  });
});

describe("sendText", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const config = (answers: Response[], whatsappFrom?: string) => {
    const calls: Record<string, string>[] = [];
    const f = (async (_url: string, init?: RequestInit) => {
      calls.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
      return answers.shift()!;
    }) as unknown as typeof fetch;
    return { calls, cfg: { accountSid: "AC1", authToken: "t", smsFrom: "NAFA", whatsappFrom, fetch: f } };
  };

  test("sends WhatsApp when configured", async () => {
    const { calls, cfg } = config([json(201, { sid: "SM1" })], "+14155238886");
    expect(await sendText(cfg, "+22670112233", "hi")).toEqual({ channel: "whatsapp", sid: "SM1" });
    expect(calls[0]).toEqual({ From: "whatsapp:+14155238886", To: "whatsapp:+22670112233", Body: "hi" });
  });

  test("falls back to SMS when WhatsApp fails", async () => {
    const { calls, cfg } = config([json(400, { message: "not on WhatsApp" }), json(201, { sid: "SM2" })], "+14155238886");
    expect(await sendText(cfg, "+22670112233", "hi")).toEqual({ channel: "sms", sid: "SM2" });
    expect(calls[1]).toEqual({ From: "NAFA", To: "+22670112233", Body: "hi" });
  });

  test("sends SMS only without a WhatsApp sender, and throws Twilio's message on failure", async () => {
    const { calls, cfg } = config([json(400, { message: "Invalid 'To'" })]);
    await expect(sendText(cfg, "+22670112233", "hi")).rejects.toThrow("Invalid 'To'");
    expect(calls).toHaveLength(1);
  });
});
