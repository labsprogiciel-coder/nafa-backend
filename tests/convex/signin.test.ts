import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema";

// convex-test locates the functions root from convex/_generated, which only
// exists once a deployment has generated it; until then a placeholder entry
// marks the root.
const modules = {
  ...import.meta.glob("../../convex/**/!(*.*.*)*.*s"),
  "../../convex/_generated/api.js": async () => ({}),
};
const PHONE = "+22670112233";

/** Texts "sent" through the mocked Twilio, newest last. */
let texts: { to: string; body: string }[] = [];

async function jwtEnv() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = btoa(String.fromCharCode(...pkcs8)).match(/.{1,64}/g)!.join(" ");
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  vi.stubEnv("JWT_PRIVATE_KEY", `-----BEGIN PRIVATE KEY----- ${b64} -----END PRIVATE KEY-----`);
  vi.stubEnv("JWKS", JSON.stringify({ keys: [{ use: "sig", ...jwk }] }));
}

beforeEach(async () => {
  texts = [];
  vi.stubEnv("CONVEX_SITE_URL", "https://nafa-test.convex.site");
  vi.stubEnv("SITE_URL", "https://nafa-test.example");
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
  vi.stubEnv("TWILIO_SMS_FROM", "NAFA");
  await jwtEnv();
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    texts.push({ to: form.get("To")!, body: form.get("Body")! });
    return new Response(JSON.stringify({ sid: `SM${texts.length}` }), { status: 201 });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const signIn = (t: ReturnType<typeof convexTest>, params: Record<string, string>) =>
  t.action(anyApi.auth.signIn, { provider: "phone", params });

const lastCode = () => /(\d{6})/.exec(texts[texts.length - 1].body)![1];

test("a new number gets a code by SMS, then signs in and sees itself", async () => {
  const t = convexTest(schema, modules);
  expect(await signIn(t, { phone: PHONE })).toEqual({ started: true });
  expect(texts).toHaveLength(1);
  expect(texts[0].to).toBe(PHONE);

  const result = await signIn(t, { phone: PHONE, code: lastCode() });
  expect(result.tokens?.token).toBeTruthy();

  const users = await t.run((ctx) => ctx.db.query("users").collect());
  expect(users).toHaveLength(1);
  expect(users[0].phone).toBe(PHONE);
  expect(users[0].phoneVerificationTime).toBeTypeOf("number");

  const session = await t.run((ctx) => ctx.db.query("authSessions").first());
  const me = await t
    .withIdentity({ subject: `${users[0]._id}|${session!._id}` })
    .query(anyApi.users.me, {});
  expect(me).toEqual({ id: users[0]._id, phone: PHONE, mizoCustomerId: null });
  expect(await t.query(anyApi.users.me, {})).toBeNull();
});

test("signing in again reuses the same saver", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const t = convexTest(schema, modules);
  await signIn(t, { phone: PHONE });
  await signIn(t, { phone: PHONE, code: lastCode() });
  vi.setSystemTime(Date.now() + 60_000);
  await signIn(t, { phone: PHONE });
  await signIn(t, { phone: PHONE, code: lastCode() });
  expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(1);
});

test("a wrong code does not sign in", async () => {
  const t = convexTest(schema, modules);
  await signIn(t, { phone: PHONE });
  const wrong = lastCode() === "000000" ? "111111" : "000000";
  await expect(signIn(t, { phone: PHONE, code: wrong })).rejects.toThrow(/Could not verify code/);
});

test("a code only works with the number it was sent to", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const t = convexTest(schema, modules);
  await signIn(t, { phone: PHONE });
  const code = lastCode();
  await expect(signIn(t, { phone: "+22670999999", code })).rejects.toThrow();
});

test("numbers outside WAEMU or not in E.164 are refused and leave nothing behind", async () => {
  const t = convexTest(schema, modules);
  for (const phone of ["+33612345678", "70112233"]) {
    await expect(signIn(t, { phone })).rejects.toThrow(/INVALID_PHONE/);
  }
  expect(texts).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.query("authAccounts").collect())).toHaveLength(0);
});

test("a second code within the cooldown is refused, and allowed after it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const t = convexTest(schema, modules);
  await signIn(t, { phone: PHONE });
  await expect(signIn(t, { phone: PHONE })).rejects.toThrow(/TOO_MANY_CODES/);
  expect(texts).toHaveLength(1);
  vi.setSystemTime(Date.now() + 46_000);
  await signIn(t, { phone: PHONE });
  expect(texts).toHaveLength(2);
});
