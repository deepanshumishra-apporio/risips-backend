// Configuration: loads the env file into process.env, validates it and exposes one typed `config`. The file is
// RISIPS_ENV if set, else .env in this folder, else ../.env (when the folder sits inside the Risips workspace).
// Variables already set in the environment win over the file (a host's settings, systemd Environment=, CI).
// Secrets are never logged. FP_ENV=production talks to the live FP tenant (real money); anything else is the sandbox.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** The backend-ts folder. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_FILE = process.env.RISIPS_ENV
  || [path.join(ROOT, '.env'), path.resolve(ROOT, '..', '.env')].find((f) => fs.existsSync(f))
  || path.join(ROOT, '.env');

if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const flag = z.enum(['0', '1']).optional();
const EnvSchema = z.object({
  FP_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  DEMO_MODE: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_URL: z.url().optional(),
  RISIPS_STATE_DIR: z.string().min(1).optional(),
  // How many reverse proxies sit in front (App Service, Caddy, ALB): req.ip is the client only when this is right.
  TRUST_PROXY: z.string().regex(/^(\d+|false)$/, 'a number of proxy hops, or "false"').optional(),
  // Signs the short-lived selfie / signature URLs and hashes OTP codes. Required in production; the sandbox makes a
  // random one per start (open OTPs and file links then stop working after a restart).
  APP_SECRET: z.string().min(32).optional(),
  FP_WEBHOOK_TOKEN: z.string().min(24).optional(),
  // Print login / transaction OTPs to the server log. Default: on in the sandbox, off in production.
  LOG_OTPS: flag,
  SESSION_IDLE_DAYS: z.coerce.number().int().min(1).default(30),
  SESSION_MAX_DAYS: z.coerce.number().int().min(1).default(180),
  // Scales every rate limit (tests and load tests raise it; 1 = the production limits).
  RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Postgres (production: AWS RDS). Without it the sandbox / laptop runs an embedded Postgres (PGlite); production refuses.
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'a postgres:// URL').optional(),
  // Admin API (/admin/v1, read-only): off unless a key is set. ADMIN_API_ALLOWED_IPS limits callers (comma-separated).
  ADMIN_API_KEY: z.string().min(24).optional(),
  ADMIN_API_ALLOWED_IPS: z.string().optional(),
});

// `NAME=` with nothing after it means "not set" (as in the JS backend: ADMIN_API_KEY= leaves the Admin API off).
const parsed = EnvSchema.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')));
if (!parsed.success) {
  const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new Error(`Invalid configuration in ${ENV_FILE}: ${msg}`);
}
const env = parsed.data;
const PROD = env.FP_ENV === 'production';
// Demo mode returns OTPs to the app and serves the MF Central stand-in, so production refuses it.
if (PROD && env.DEMO_MODE && env.DEMO_MODE !== '0') throw new Error('FP_ENV=production cannot run with DEMO_MODE on');
if (PROD && !env.APP_SECRET) throw new Error(`Missing APP_SECRET (32+ random characters) in ${ENV_FILE}`);
if (PROD && !env.DATABASE_URL) throw new Error(`FP_ENV=production needs DATABASE_URL (the RDS Postgres database) in ${ENV_FILE}`);

// Writable state (embedded Postgres when there is no DATABASE_URL, uploads, logs). On Azure this points at persistent /home storage.
// Production gets its own folder: sandbox users carry sandbox FP ids that mean nothing on the live tenant.
export const STATE_DIR = env.RISIPS_STATE_DIR || (PROD ? path.join(ROOT, 'state-production') : ROOT);

const need = (k: string): string => {
  if (!process.env[k]) throw new Error(`Missing ${k} in ${ENV_FILE}`);
  return process.env[k];
};

const demoMode = !PROD && env.DEMO_MODE !== '0';

export const config = {
  port: env.PORT,
  // Public base URL the phone/emulator uses to reach this server (payment return pages).
  publicUrl: env.PUBLIC_URL || `http://10.0.2.2:${env.PORT}`,
  fpEnv: env.FP_ENV,
  production: PROD,
  // Sandbox helpers: return OTPs in API responses so the demo can be driven without SMS/email.
  demoMode,
  logOtps: env.LOG_OTPS ? env.LOG_OTPS === '1' : !PROD,
  trustProxy: env.TRUST_PROXY === undefined ? 1 : env.TRUST_PROXY === 'false' ? false : Number(env.TRUST_PROXY),
  databaseUrl: env.DATABASE_URL || null,
  appSecret: env.APP_SECRET || crypto.randomBytes(32).toString('hex'),
  webhookToken: env.FP_WEBHOOK_TOKEN || '',
  session: { idleDays: env.SESSION_IDLE_DAYS, maxDays: env.SESSION_MAX_DAYS },
  rateLimitScale: env.RATE_LIMIT_SCALE,
  logLevel: env.LOG_LEVEL,
  admin: {
    key: env.ADMIN_API_KEY || '',
    allowedIps: (env.ADMIN_API_ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  // Tokens come from `${authBase}/v2/auth/<tenant or authTenant>/token`.
  fp: PROD ? {
    base: need('FP_BASE_URL'),
    authBase: need('FP_BASE_URL'),
    tenant: need('FP_TENANT'),
    clientId: need('FP_CLIENT_ID'),
    clientSecret: need('FP_CLIENT_SECRET'),
  } : {
    base: process.env.FP_SANDBOX_BASE_URL || 'https://s.finprim.com',
    authBase: process.env.FP_SANDBOX_BASE_URL || 'https://s.finprim.com',
    tenant: process.env.FP_SANDBOX_TENANT || 'thestupidinvestor',
    clientId: need('FP_SANDBOX_CLIENT_ID'),
    clientSecret: need('FP_SANDBOX_CLIENT_SECRET'),
  },
  // Pre-verification. Production takes its token from FP's central auth host (realm cybrillapoa), not the tenant host.
  pv: PROD ? {
    base: need('FP_PV_BASE_URL'),
    authBase: need('FP_PV_AUTH_URL'),
    authTenant: need('FP_PV_AUTH_TENANT'),
    clientId: need('FP_PV_CLIENT_ID'),
    clientSecret: need('FP_PV_CLIENT_SECRET'),
  } : {
    base: process.env.FP_PV_SANDBOX_BASE_URL || 'https://api.sandbox.cybrilla.com',
    authBase: process.env.FP_SANDBOX_BASE_URL || 'https://s.finprim.com',
    authTenant: process.env.FP_PV_SANDBOX_AUTH_TENANT || 'cybrillarta',
    clientId: need('FP_PV_SANDBOX_CLIENT_ID'),
    clientSecret: need('FP_PV_SANDBOX_CLIENT_SECRET'),
  },
};

export const paths = {
  root: ROOT,
  state: STATE_DIR,
  data: path.join(STATE_DIR, 'data'),
  uploads: path.join(STATE_DIR, 'uploads'),
  logs: path.join(STATE_DIR, 'logs'),
  catalog: path.join(ROOT, 'data', 'catalog.json'),
  catalogProdRules: path.join(ROOT, 'data', 'catalog-rules.production.json'),
  content: path.join(ROOT, 'src', 'content'),
};
