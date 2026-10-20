import { describe, expect, test } from "vitest";
import { createMizoClient } from "../convex/lib/mizo";

const KEY = "mzk_" + "ab".repeat(32);
const SITE = "https://mizo.example.convex.site/";

type Call = { url: string; init: RequestInit };

/** A fake fetch answering from a list of responses (or errors), recording calls. */
function fakeFetch(answers: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: impl as typeof fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const client = (f: typeof fetch, attempts = 3) =>
  createMizoClient({ siteUrl: SITE, apiKey: KEY, fetch: f, attempts, backoffMs: () => 0 });

describe("config", () => {
  test("refuses a non-https URL or a malformed key", () => {
    expect(() => createMizoClient({ siteUrl: "http://x", apiKey: KEY })).toThrow(/https/);
    expect(() => createMizoClient({ siteUrl: SITE, apiKey: "nope" })).toThrow(/partner key/);
  });
});

describe("requests", () => {
  test("sends the bearer key and builds the URL without a double slash", async () => {
    const f = fakeFetch([json(200, { currency: "XOF", products: [] })]);
    const r = await client(f.fetch).catalogue();
    expect(r).toEqual({ ok: true, data: { currency: "XOF", products: [] } });
    expect(f.calls[0].url).toBe("https://mizo.example.convex.site/api/v1/catalogue");
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(f.calls[0].init.method).toBe("GET");
  });

  test("encodes query parameters and leaves out undefined ones", async () => {
    const f = fakeFetch([json(200, [])]);
    await client(f.fetch).transactions({ customerId: "a b&c", limit: 20 });
    expect(f.calls[0].url).toBe("https://mizo.example.convex.site/api/v1/transactions?customerId=a+b%26c&limit=20");
  });

  test("posts JSON bodies", async () => {
    const f = fakeFetch([json(200, { transactionId: "t1", status: "completed", balance: 5000, replayed: false })]);
    const r = await client(f.fetch).deposit({ customerId: "c1", productCode: "NAFA-LIBRE", amount: 5000, reference: "pg_1" });
    expect(r.ok && r.data.balance).toBe(5000);
    expect(f.calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ customerId: "c1", productCode: "NAFA-LIBRE", amount: 5000, reference: "pg_1" });
  });
});

describe("Mizo refusals", () => {
  test("come back as typed errors with their details, without retrying", async () => {
    const f = fakeFetch([json(422, { error: "LOCKED", lockedUntil: 1_800_000_000_000 })]);
    const r = await client(f.fetch).withdraw({ customerId: "c1", productCode: "NAFA-MAISON", amount: 1000, reference: "pg_2" });
    expect(r).toEqual({ ok: false, error: { code: "LOCKED", status: 422, details: { lockedUntil: 1_800_000_000_000 } } });
    expect(f.calls).toHaveLength(1);
  });

  test("PHONE_TAKEN carries the existing customer", async () => {
    const f = fakeFetch([json(409, { error: "PHONE_TAKEN", customerId: "c9" })]);
    const r = await client(f.fetch).createCustomer({ fullName: "Awa", phoneNumber: "70112233" });
    expect(!r.ok && r.error.details.customerId).toBe("c9");
  });

  test("an unknown code or a body that isn't JSON is UNEXPECTED", async () => {
    const f = fakeFetch([json(400, { error: "SOMETHING_NEW" }), new Response("oops", { status: 404 })]);
    const c = client(f.fetch);
    expect(await c.customer("c1")).toMatchObject({ ok: false, error: { code: "UNEXPECTED", status: 400 } });
    expect(await c.customer("c1")).toMatchObject({ ok: false, error: { code: "UNEXPECTED", status: 404 } });
  });
});

describe("retries", () => {
  test("retry network errors and 5xx, then succeed", async () => {
    const f = fakeFetch([new TypeError("fetch failed"), json(503, {}), json(200, { customerId: "c1", status: "prospect" })]);
    const r = await client(f.fetch).createCustomer({ fullName: "Awa", phoneNumber: "70112233" });
    expect(r.ok).toBe(true);
    expect(f.calls).toHaveLength(3);
  });

  test("give up as UNAVAILABLE after the last attempt", async () => {
    const f = fakeFetch([json(500, {}), json(502, {})]);
    const r = await client(f.fetch, 2).catalogue();
    expect(r).toEqual({ ok: false, error: { code: "UNAVAILABLE", status: 502, details: {} } });
  });

  test("a retried movement sends the same reference each time", async () => {
    const f = fakeFetch([new TypeError("reset"), json(200, { transactionId: "t1", status: "completed", balance: 0, replayed: true })]);
    const r = await client(f.fetch).withdraw({ customerId: "c1", productCode: "NAFA-LIBRE", amount: 100, reference: "pg_3" });
    expect(r.ok && r.data.replayed).toBe(true);
    expect(f.calls.map((c) => JSON.parse(String(c.init.body)).reference)).toEqual(["pg_3", "pg_3"]);
  });

  test("time out a hanging request and retry it", async () => {
    let n = 0;
    const hanging = (async (_url: string, init?: RequestInit) => {
      n++;
      if (n === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return json(200, { currency: "XOF", products: [] });
    }) as unknown as typeof fetch;
    const c = createMizoClient({ siteUrl: SITE, apiKey: KEY, fetch: hanging, timeoutMs: 20, backoffMs: () => 0 });
    expect((await c.catalogue()).ok).toBe(true);
    expect(n).toBe(2);
  });
});
