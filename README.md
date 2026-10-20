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
| `tests/` | Client tests against a mocked Mizo |

## Set up

```bash
pnpm install
npx convex dev            # first run: creates the deployment and generates convex/_generated
npx convex env set MIZO_SITE_URL https://<mizo-deployment>.convex.site
npx convex env set MIZO_API_KEY mzk_…     # from apiClients:create in Mizo; never commit it
```

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
