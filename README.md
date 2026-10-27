# Risips backend (TypeScript)

The API behind the Risips app: sign-in, KYC onboarding, funds, orders, SIP/STP/SWP, cart, reports, notifications,
MF Central import, and a read-only Admin API. Express 5 on Node 24, PostgreSQL with Drizzle ORM, zod validation.
A standalone repo, hosted on its own. It replaces the JavaScript backend (`akashatbest/risips`, branch
`fp-demo-invest-screens`) and can take over that backend's database in place.

## Run

```bash
npm install
npm run dev          # watch mode, sandbox
npm start            # FP_ENV=production for the live tenant
npm run typecheck    # tsc --noEmit, strict mode
npm run lint         # ESLint, type-aware: no un-awaited promise, no await on a non-promise
npm test             # node:test: security, rate limits, validation, migrations, Admin API
npm run check        # all three
```

Node runs the `.ts` files directly by stripping the types: no build step. That needs Node 22.18+ (or 22.6+ with the
`--experimental-strip-types` flag the npm scripts pass). Configuration: copy [`.env.example`](.env.example) to `.env`
(gitignored), or set the same keys as environment variables on the host (they win over the file); `RISIPS_ENV` can
point at another file. Production refuses to start without `APP_SECRET` or `DATABASE_URL`, or with
`DEMO_MODE` on. A key set to nothing (`NAME=`) counts as not set.

## Database

PostgreSQL, the same schema as the JavaScript backend (`src/db/migrations.ts`, migration 1), plus migration 2:
session tokens and OTP codes stored only as hashes, and an index for the background jobs.

- **Queries:** [Drizzle ORM](https://orm.drizzle.team) on the tables in `src/db/schema.ts`; every query is in
  `src/db/repositories/`. JSONB merges and row locks use Drizzle's `sql` template (still parameterised).
- **Schema changes:** add a migration to `migrations.ts` (plain SQL, applied at start-up) **and** change `schema.ts`.
  `test/schema.test.ts` fails if the two disagree on a table, column, type, nullability or index. drizzle-kit isn't
  used: the hand-written migrations are what let this backend take over the JavaScript backend's database in place.
- Timestamps come out as `'YYYY-MM-DD HH:MM:SS'` (UTC), the format the app and the Admin API have always had.

- **Production:** `DATABASE_URL=postgres://…` (AWS RDS Postgres 17), through a `pg` pool of 10 connections. The pool is
  set up exactly like the JavaScript backend's, so the same `DATABASE_URL` (including its SSL parameters) works.
- **Laptop / sandbox:** no `DATABASE_URL` runs an embedded Postgres (PGlite) in `<state>/data/pg`. A lock file
  (`data/pg.lock`) stops a second server from opening the same folder.
- **Migrations** run at start-up, each in one transaction; the version is in `meta.schema_version`. Taking over a
  database the JavaScript backend created keeps every session (tokens are hashed in place). Going back to the
  JavaScript backend afterwards only signs everyone out.
- **From SQLite:** an old `data/risips.db` is copied into the embedded Postgres on the first start. For production,
  stop the old server and run `DATABASE_URL=… npm run migrate-sqlite -- /path/to/risips.db` (one transaction; refuses
  if Postgres already has users).
- User and order details live in JSONB `data` columns. Read-modify-write of a user (cart, MF Central state, account
  deletion) runs under a row lock (`usersRepo.update`), so parallel requests can't overwrite each other.
- The API is meant to run as **one process**: rate-limit counters, the cart double-tap guard and the background jobs
  are in memory. Before running more than one instance, move those to Redis / a worker.

## Admin API

Read-only investor and order data for the admin dashboard's backend, at `/admin/v1`. Off (404) unless
`ADMIN_API_KEY` (24+ characters) is set. Every call sends `x-admin-key` and `x-admin-actor` (the staff user), and is
logged to `logs/admin_api.log`. `ADMIN_API_ALLOWED_IPS` limits callers. Only GET; full PAN, bank account numbers,
Aadhaar, files, payment links and session data are never returned.

| Path | |
|---|---|
| `GET /admin/v1/summary` | investor stages, order counts and amounts by kind and state |
| `GET /admin/v1/investors?q=&stage=&limit=&offset=` | investors (q matches name, email, mobile, id) |
| `GET /admin/v1/investors/:id` | profile (masked), orders, SIPs, STPs, SWPs |
| `GET /admin/v1/investors/:id/portfolio` | holdings, live from FP |
| `GET /admin/v1/orders?kind=&state=&user_id=&from=&to=&limit=&offset=` | orders and plans across investors |
| `GET /admin/v1/orders/:id` | one order or plan |

## Layout

```
src/
  server.ts            starts the HTTP server and background jobs; graceful shutdown on SIGTERM
  app.ts               the Express app: headers, request ids, body limits, rate limits, routes, errors
  config/env.ts        .env loading, validated with zod, one typed `config`
  routes/              path -> middleware (auth, rate limit, validation) -> controller; index.ts mounts them all
  validation/          zod schemas for every body, query and path parameter (messages are what the app shows)
  controllers/         read the validated input, call a service, send the response
  services/            the business logic; no Express in here (they take a user / a context and plain data)
  integrations/        FintechPrimitives, AMFI, MF Central (+ its sandbox stand-in), NSE holidays
  db/                  connection (pg pool or embedded PGlite) + Drizzle, schema.ts, migrations, SQLite import, repositories
  middleware/          auth, validation, rate limits, security headers, body parser, errors, request context
  jobs/scheduler.ts    background sweeps (SIP first payments, account purge, MF Central imports, cleanup)
  types/               domain, catalogue and external-holding types; the Express request extension
  utils/               errors, logger, crypto, dates/money formatting, masking, PII redaction
  content/             promos, announcements, holiday fallback (edited without a code change)
test/                  node:test suites; smoke-onboard.cjs drives a running server end to end
scripts/               catalogue build, fund data, production rules, webhook registration, SQLite -> Postgres copy
```

A request: `routes/x.routes.ts` -> `requireAuth` -> `limits.*` -> `validate(schema)` -> `controllers/x.controller.ts`
-> `services/x.service.ts` -> repositories / integrations. Errors are thrown as `ApiError(status, message, extra)`
and turned into `{ error, ...extra }` by `middleware/errorHandler.ts`.

## Security

- **Validation:** every input goes through a zod schema; unknown fields are dropped. A bad body or query is a 400 with
  `{ error, reason: 'validation', fields }`; a malformed id in the path is a 404.
- **Rate limits** (`middleware/rateLimit.ts`): 300 req/min per IP overall; sign-in codes 5 per email and 10 per IP
  per 15 min; code checks 20 per IP; PIN tries 10 per user; KYC checks 10 per user per hour; orders and plans 30 per
  user per 10 min. The counters are in memory: with more than one instance, add a shared store (Redis).
- **Sessions:** random 24-byte tokens, stored only as SHA-256 hashes; end after 30 days unused or 180 days in total.
- **OTPs:** stored as HMACs, 5 wrong tries lock a code; returned to the app only in demo mode; printed to the log only
  when `LOG_OTPS` allows (off in production).
- **PIN:** scrypt, constant-time comparison, 5 wrong tries end the session.
- **Files:** selfies and signatures are served only through signed links that expire within 2 hours; uploads must
  really be PNG / JPEG.
- **Logs:** PAN, bank, phone, email, address and names are masked in the FP call log outside demo mode; logs are JSON
  lines in production, with a request id that is also returned in `X-Request-Id`.
- **Errors:** FP's raw replies and stack traces stay in the log; the app gets a message.
- **Headers:** helmet (strict CSP for JSON, a page CSP for the few HTML pages), no `X-Powered-By`, `no-store` on
  personal data. JSON bodies are capped at 100 KB (12 MB on the three image routes).
- **Webhooks:** a 24+ character secret in the URL, compared in constant time; the event only triggers a re-fetch from FP.
- **Admin API:** key compared in constant time, optional IP allowlist, GET only, audit log with the staff actor,
  its own rate limit (600/min).

## Rules for the code

Only "erasable" TypeScript (`erasableSyntaxOnly`): no `enum`, `namespace` or constructor parameter properties;
type-only imports say `import type`; relative imports end in `.ts`.
