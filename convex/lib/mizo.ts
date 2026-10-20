// convex/lib/mizo.ts — typed client for the Mizo partner API
//
// Mizo (TontiPro-Admin) keeps the institution's ledger: customers, KYC,
// balances. Nafa calls it as a partner, server to server, with a secret key.
// Reference: TontiPro-Admin docs/partner-api.md.
//
// Every call returns a MizoResult instead of throwing for Mizo's own refusals
// (LOCKED, INSUFFICIENT_BALANCE…), so callers handle them like data. Network
// errors and 5xx responses are retried; movements are safe to retry because
// Mizo is idempotent on `reference` (the Paygate payment ID).

/** Error codes Mizo returns, from docs/partner-api.md. */
export type MizoErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_AMOUNT"
  | "INVALID_REFERENCE"
  | "INVALID_PHONE"
  | "NAME_REQUIRED"
  | "INVALID_ID_NUMBER"
  | "UNAUTHORIZED"
  | "PARTNER_NOT_FOUND"
  | "CUSTOMER_NOT_FOUND"
  | "PRODUCT_NOT_FOUND"
  | "TRANSACTION_NOT_FOUND"
  | "PHONE_TAKEN"
  | "DUPLICATE_REFERENCE"
  | "DAY_CLOSED"
  | "PRODUCT_NOT_AVAILABLE"
  | "CUSTOMER_REJECTED"
  | "BELOW_MIN_DEPOSIT"
  | "OVER_MAX_BALANCE"
  | "LOCKED"
  | "INSUFFICIENT_BALANCE"
  | "CANCEL_WINDOW_PASSED"
  /** Mizo was unreachable or kept failing after the retries. */
  | "UNAVAILABLE"
  /** A response Mizo isn't documented to send. */
  | "UNEXPECTED";

export type MizoError = {
  code: MizoErrorCode;
  /** HTTP status, or 0 when no response arrived. */
  status: number;
  /** Extra fields Mizo sends with some codes: customerId, minDeposit, maxBalance, lockedUntil. */
  details: Record<string, unknown>;
};

export type MizoResult<T> = { ok: true; data: T } | { ok: false; error: MizoError };

export type Product = {
  code: string;
  name: string;
  family: "epargne" | "tontine";
  summary: string;
  /** % per year */
  rate: number;
  /** months; 0 / 0 = no duration */
  durationMin: number;
  durationMax: number;
  /** first deposit minimum, in the organization's currency */
  minDeposit: number;
  /** 0 = no ceiling */
  maxBalance: number;
  fees: number;
  feesUnit: "FCFA" | "%";
  /** days */
  grace: number;
  kycLevel: string;
  updatedAt: number;
};

export type Catalogue = { currency: string; products: Product[] };

export type CustomerStatus = "prospect" | "verified" | "rejected";

export type Vault = {
  productCode: string;
  productName: string;
  rate: number;
  balance: number;
  /** ms, null before the first deposit */
  firstDepositAt: number | null;
  /** ms, null when the product has no minimum duration */
  lockedUntil: number | null;
};

export type Customer = {
  customerId: string;
  fullName: string;
  phoneNumber: string;
  status: CustomerStatus;
  /** all products together */
  balance: number;
  vaults: Vault[];
};

export type Transaction = {
  transactionId: string;
  reference: string | null;
  type: "deposit" | "withdrawal";
  amount: number;
  currency: string;
  productCode: string | null;
  status: "completed" | "reversed";
  reversalReason: string | null;
  timestamp: number;
};

export type Movement = {
  transactionId: string;
  status: "completed" | "reversed";
  /** the vault's balance after this movement */
  balance: number;
  /** true when `reference` was already stored and nothing moved */
  replayed: boolean;
};

export type MovementInput = {
  customerId: string;
  productCode: string;
  /** whole units of the currency, > 0 */
  amount: number;
  /** Paygate payment ID, ≤ 64 characters */
  reference: string;
};

export type MizoConfig = {
  /** the deployment's .convex.site address */
  siteUrl: string;
  /** the partner key, mzk_… */
  apiKey: string;
  fetch?: typeof fetch;
  /** attempts per call, including the first (default 3) */
  attempts?: number;
  /** per attempt (default 10 s) */
  timeoutMs?: number;
  /** wait before retry n (1-based), in ms (default 250 × 2^(n-1)) */
  backoffMs?: (retry: number) => number;
};

const KNOWN_CODES = new Set<string>([
  "INVALID_REQUEST", "INVALID_AMOUNT", "INVALID_REFERENCE", "INVALID_PHONE", "NAME_REQUIRED",
  "INVALID_ID_NUMBER", "UNAUTHORIZED", "PARTNER_NOT_FOUND", "CUSTOMER_NOT_FOUND",
  "PRODUCT_NOT_FOUND", "TRANSACTION_NOT_FOUND", "PHONE_TAKEN", "DUPLICATE_REFERENCE", "DAY_CLOSED",
  "PRODUCT_NOT_AVAILABLE", "CUSTOMER_REJECTED", "BELOW_MIN_DEPOSIT", "OVER_MAX_BALANCE", "LOCKED",
  "INSUFFICIENT_BALANCE", "CANCEL_WINDOW_PASSED",
]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMizoClient(config: MizoConfig) {
  if (!/^https:\/\//.test(config.siteUrl)) throw new Error("MIZO_SITE_URL must be an https URL");
  if (!/^mzk_[0-9a-f]{64}$/.test(config.apiKey)) throw new Error("MIZO_API_KEY is not a Mizo partner key");
  const base = config.siteUrl.replace(/\/+$/, "");
  const doFetch = config.fetch ?? fetch;
  const attempts = Math.max(1, config.attempts ?? 3);
  const timeoutMs = config.timeoutMs ?? 10_000;
  const backoffMs = config.backoffMs ?? ((retry: number) => 250 * 2 ** (retry - 1));

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<MizoResult<T>> {
    let last: MizoError = { code: "UNAVAILABLE", status: 0, details: {} };
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await sleep(backoffMs(attempt - 1));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch {
        // Network error or timeout: Mizo may or may not have applied a POST,
        // which is why movements carry an idempotent reference
        last = { code: "UNAVAILABLE", status: 0, details: {} };
        continue;
      } finally {
        clearTimeout(timer);
      }

      const payload = await res.json().catch(() => null);
      if (res.status >= 500) {
        last = { code: "UNAVAILABLE", status: res.status, details: {} };
        continue;
      }
      if (res.ok) {
        if (payload === null) return { ok: false, error: { code: "UNEXPECTED", status: res.status, details: {} } };
        return { ok: true, data: payload as T };
      }
      // 4xx: Mizo's answer, never retried
      const { error, ...details } = (payload ?? {}) as { error?: unknown };
      const code = typeof error === "string" && KNOWN_CODES.has(error) ? (error as MizoErrorCode) : "UNEXPECTED";
      return { ok: false, error: { code, status: res.status, details } };
    }
    return { ok: false, error: last };
  }

  const query = (params: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) search.set(k, String(v));
    return search.toString();
  };

  return {
    /** Active savings products offered to Nafa. */
    catalogue: () => call<Catalogue>("GET", "/api/v1/catalogue"),

    /**
     * Register a saver as a prospect. PHONE_TAKEN carries the existing
     * `details.customerId`: link that customer instead of failing (a retried
     * call that Mizo already applied also ends here).
     */
    createCustomer: (input: { fullName: string; phoneNumber: string; idNumber?: string }) =>
      call<{ customerId: string; status: "prospect" }>("POST", "/api/v1/customers", input),

    /** KYC status, total balance and one vault per product used. */
    customer: (customerId: string) => call<Customer>("GET", `/api/v1/customer?${query({ customerId })}`),

    /** Movements, newest first, optionally on one product (limit 1–500, default 100). */
    transactions: (input: { customerId: string; productCode?: string; limit?: number }) =>
      call<Transaction[]>("GET", `/api/v1/transactions?${query(input)}`),

    /** Credit a vault once Paygate confirms the collection. */
    deposit: (input: MovementInput) => call<Movement>("POST", "/api/v1/deposits", input),

    /** Debit a vault before sending the Paygate payout. */
    withdraw: (input: MovementInput) => call<Movement>("POST", "/api/v1/withdrawals", input),

    /** Put a withdrawal back when its payout failed (within 24 h, before the day is reconciled). */
    cancelWithdrawal: (input: { reference: string; reason?: string }) =>
      call<{ transactionId: string; status: "reversed" }>("POST", "/api/v1/withdrawals/cancel", input),
  };
}

export type MizoClient = ReturnType<typeof createMizoClient>;

/** The client configured from the deployment's environment variables. */
export function mizoFromEnv(): MizoClient {
  const siteUrl = process.env.MIZO_SITE_URL;
  const apiKey = process.env.MIZO_API_KEY;
  if (!siteUrl || !apiKey) throw new Error("Set MIZO_SITE_URL and MIZO_API_KEY with `npx convex env set`");
  return createMizoClient({ siteUrl, apiKey });
}
