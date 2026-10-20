import { describe, expect, test } from "vitest";
import { codeMessage, generateCode, isAcceptedPhone, SEND_COOLDOWN_MS, sendAllowed } from "../convex/lib/phone";
import { sendCode } from "../convex/lib/twilio";

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

describe("sendCode", () => {
  type Call = { method: string; path: string; form: Record<string, string> };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  /** A fake Twilio answering POST /Messages.json and GET /Messages/<sid>.json from queues. */
  const twilio = (opts: { posts: Response[]; statuses?: string[]; whatsapp?: boolean }) => {
    const calls: Call[] = [];
    const statuses = [...(opts.statuses ?? [])];
    const f = (async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/Accounts\/[^/]+/, "");
      calls.push({ method: init?.method ?? "GET", path, form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))) });
      if (init?.method === "POST") return opts.posts.shift()!;
      return json(200, { sid: "WA1", status: statuses.shift() ?? "queued" });
    }) as unknown as typeof fetch;
    const cfg = {
      accountSid: "AC1",
      authToken: "t",
      smsFrom: "NAFA",
      whatsapp: opts.whatsapp ? { from: "+14155238886", contentSid: "HX123" } : undefined,
      fetch: f,
      statusChecks: 3,
      statusIntervalMs: 0,
    };
    return { calls, cfg };
  };

  test("sends SMS only without a WhatsApp template", async () => {
    const { calls, cfg } = twilio({ posts: [json(201, { sid: "SM1", status: "queued" })] });
    expect(await sendCode(cfg, "+22670112233", "123456", "Votre code : 123456")).toEqual({ channel: "sms", sid: "SM1" });
    expect(calls).toEqual([{ method: "POST", path: "/Messages.json", form: { From: "NAFA", To: "+22670112233", Body: "Votre code : 123456" } }]);
  });

  test("sends the WhatsApp template with the code as variable 1, and returns once Twilio says sent", async () => {
    const { calls, cfg } = twilio({ posts: [json(201, { sid: "WA1", status: "queued" })], statuses: ["queued", "sent"], whatsapp: true });
    expect(await sendCode(cfg, "+22670112233", "123456", "sms")).toEqual({ channel: "whatsapp", sid: "WA1" });
    expect(calls[0].form).toEqual({ From: "whatsapp:+14155238886", To: "whatsapp:+22670112233", ContentSid: "HX123", ContentVariables: '{"1":"123456"}' });
    expect(calls.slice(1).map((c) => `${c.method} ${c.path}`)).toEqual(["GET /Messages/WA1.json", "GET /Messages/WA1.json"]);
  });

  test("falls back to SMS when the WhatsApp message fails after being accepted", async () => {
    const { calls, cfg } = twilio({
      posts: [json(201, { sid: "WA1", status: "queued" }), json(201, { sid: "SM2", status: "queued" })],
      statuses: ["failed"],
      whatsapp: true,
    });
    expect(await sendCode(cfg, "+22670112233", "123456", "sms text")).toEqual({ channel: "sms", sid: "SM2" });
    expect(calls[calls.length - 1].form).toEqual({ From: "NAFA", To: "+22670112233", Body: "sms text" });
  });

  test("falls back to SMS when Twilio refuses the WhatsApp message outright", async () => {
    const { cfg } = twilio({ posts: [json(400, { message: "bad" }), json(201, { sid: "SM3" })], whatsapp: true });
    expect(await sendCode(cfg, "+22670112233", "1", "s")).toEqual({ channel: "sms", sid: "SM3" });
  });

  test("treats a WhatsApp message still queued after the checks as on its way", async () => {
    const { calls, cfg } = twilio({ posts: [json(201, { sid: "WA1" })], statuses: ["queued", "queued", "queued"], whatsapp: true });
    expect(await sendCode(cfg, "+22670112233", "1", "s")).toEqual({ channel: "whatsapp", sid: "WA1" });
    expect(calls).toHaveLength(4);
  });

  test("throws Twilio's message when the SMS fails", async () => {
    const { cfg } = twilio({ posts: [json(400, { message: "Invalid 'To'" })] });
    await expect(sendCode(cfg, "+22670112233", "1", "s")).rejects.toThrow("Invalid 'To'");
  });
});
