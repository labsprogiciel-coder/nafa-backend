# Nafa backend

The server behind the [Nafa app](https://github.com/labsprogiciel-coder/nafaa). It holds the secrets the app must never carry and talks to the two services money depends on:

- **Mizo** ([TontiPro-Admin](https://github.com/labsprogiciel-coder/TontiPro-Admin)): the microfinance institution's ledger. Nafa calls its partner API to register savers, read vaults and record deposits and withdrawals. Reference: `docs/partner-api.md` in that repo.
- **Paygate** ([paygate](https://github.com/labsprogiciel-coder/paygate)): mobile money and PI-SPI collections and payouts. Not wired yet.

```
Nafa app ──► Nafa backend ──► Mizo partner API
                  └─────────► Paygate
```

Built on [Convex](https://convex.dev), like Mizo. Plan: Linear project "Integrate Nafa with Mizo".

## What's here

| Path | What |
|---|---|
| `convex/lib/mizo.ts` | Typed client for the Mizo partner API: one function per route, Mizo's refusals as typed results, retries on network errors and 5xx |
| `convex/mizo.ts` | The same calls as internal actions, for this backend's own code and the CLI |
| `convex/auth.ts` | Saver sign-in with a phone number and a one-time code (Convex Auth) |
| `convex/lib/phone.ts`, `convex/lib/twilio.ts`, `convex/otp.ts` | Accepted numbers, codes, sending through Twilio, the send limit |
| `convex/users.ts` | `users.me`: the signed-in saver |
| `convex/lib/functions.ts` | Function builders typed with the schema, until a deployment generates `convex/_generated` |
| `tests/` | Mizo client tests against a mocked Mizo; sign-in tests run in memory (convex-test) with Twilio mocked |

## Set up

```bash
pnpm install
npx convex dev            # first run: creates the deployment and generates convex/_generated
npx convex env set MIZO_SITE_URL https://<mizo-deployment>.convex.site
npx convex env set MIZO_API_KEY mzk_…     # from apiClients:create in Mizo; never commit it
npx @convex-dev/auth                       # sets JWT_PRIVATE_KEY, JWKS and SITE_URL for sign-in
npx convex env set TWILIO_ACCOUNT_SID AC…
npx convex env set TWILIO_AUTH_TOKEN …
npx convex env set TWILIO_SMS_FROM NAFA    # SMS sender number or ID
npx convex env set TWILIO_WHATSAPP_FROM +…          # optional, with the next one: WhatsApp first,
npx convex env set TWILIO_WHATSAPP_CONTENT_SID HX… #   using an approved template, code as {{1}}
```

`SITE_URL` is required by Convex Auth but unused by phone sign-in: any absolute https URL works (the website, once it exists).

## Saver sign-in

Savers sign in with their phone number and a 6-digit code; they never sign in to Mizo. From the app, with the Convex Auth client:

```ts
await signIn("phone", { phone: "+22670112233" });           // sends the code
await signIn("phone", { phone: "+22670112233", code });     // signs in, creating the saver the first time
const me = useQuery(api.users.me);                          // { id, phone, mizoCustomerId } or null
```

- **The app formats the number** in E.164 (`+`, country code, national number, digits only). The backend never guesses a country: the stored number is the saver's identity. Only WAEMU country codes are accepted (`ALLOWED_COUNTRY_CODES` in `convex/lib/phone.ts`); anything else fails with `INVALID_PHONE` before a code is sent or a row written.
- **Codes** are 6 digits, valid 10 minutes, sent by SMS. With a WhatsApp sender **and** an approved WhatsApp template configured, WhatsApp goes first: WhatsApp only lets a business start a conversation with a template, so a free-form message would be accepted by Twilio and then fail. After a WhatsApp send the backend checks the message status for a few seconds and falls back to SMS if it failed (for example, a number not on WhatsApp). Twilio Verify is avoided on purpose: its SMS channel blocked some local prefixes for the TontiPro app.
- **Limits:** one code per number every 45 seconds and 5 per hour (`TOO_MANY_CODES` with `retryAfterMs`), so nobody can run up the SMS bill. A refused request changes nothing: the code the saver already received keeps working. Convex Auth limits wrong codes to 10 per hour per number.
- The app's 4-digit PIN stays on the device: it unlocks the app and withdrawals and never reaches this server.

## Try it against Mizo

Every call is an internal action: it runs from the CLI, never from the app.

```bash
npx convex run mizo:catalogue
npx convex run mizo:createCustomer '{"fullName":"Awa Ouédraogo","phoneNumber":"70112233"}'
npx convex run mizo:deposit '{"customerId":"…","productCode":"NAFA-LIBRE","amount":5000,"reference":"test-1"}'
npx convex run mizo:customer '{"customerId":"…"}'
```

Each returns `{ ok: true, data }` or `{ ok: false, error: { code, status, details } }`, with `code` one of Mizo's (`LOCKED`, `INSUFFICIENT_BALANCE`, `BELOW_MIN_DEPOSIT`…), `UNAVAILABLE` after the retries, or `UNEXPECTED`.

## Rules

- The Mizo key lives only in the deployment's environment variables.
- Every deposit and withdrawal sends the Paygate payment ID as `reference`. Mizo stores a reference once, so retries never move money twice.
- Withdraw in Mizo **before** sending a payout; if the payout fails, call `cancelWithdrawal`.

## Checks

```bash
pnpm typecheck
pnpm test
```

## CI/CD

`.github/workflows/ci-cd.yml`:

| When | What |
|---|---|
| Every pull request and push to `main` | Typecheck and tests |
| Pull request, checks green | Deploy the branch to its own Convex preview deployment (`pr-<number>`), reused across pushes |
| Push to `main`, checks green | Deploy to production, unless a newer `main` commit exists |

**GitHub secrets** (Settings → Secrets and variables → Actions):

- `CONVEX_DEPLOY_KEY`: the production deploy key (`prod:…`), from the production deployment's settings in the Convex dashboard. Without it, merges to `main` fail the deploy step.
- `CONVEX_PREVIEW_DEPLOY_KEY`: a preview deploy key (`preview:…`), from Project settings → Preview deploy keys. Without it, previews are skipped with a notice.

**Mizo settings per environment.** The Mizo key is not a CI secret; it lives in each Convex deployment:

- Production: `npx convex env set --prod MIZO_SITE_URL …` and `MIZO_API_KEY …`, pointing at **production Mizo**.
- Previews: set `MIZO_SITE_URL` and `MIZO_API_KEY` as default environment variables for preview deployments (Convex dashboard → Project settings → Environment variables), pointing at a **Mizo dev or preview** partner, never production.
