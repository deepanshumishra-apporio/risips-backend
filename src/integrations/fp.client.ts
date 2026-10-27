// FintechPrimitives clients (main API + pre-verification API) with token caching, 429 backoff, one retry on a network
// failure, and a request/response trace (logs/fp_calls.log + an in-memory ring buffer for the demo's "API log" screen).
// Outside demo mode both are redacted: PAN, bank, phone, email, address and names never reach a log.
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config/env.ts';
import { sleep } from '../utils/async.ts';
import { log } from '../utils/logger.ts';
import { redact } from '../utils/redact.ts';
import type { FpObject } from '../types/domain.ts';

type Kind = 'fp' | 'pv';
/** One request/response in the API log. */
export interface TraceEntry {
  seq?: number; at: string; label?: string; method: string; url: string; body?: unknown; status: number; ms: number; response: unknown;
}
/**
 * quiet: a status poll (not logged). Polls also get a short per-request timeout: a poll that hangs must not eat the
 * whole polling budget (seen 2026-10-22: one sandbox poll hung for the full 45 s).
 */
export interface CallOptions { label?: string; quiet?: boolean; timeoutMs?: number }
const REQUEST_TIMEOUT_MS = 45000;
const POLL_TIMEOUT_MS = 10000;
/** FP's reply: JSON when it parses, else the raw text. */
 
export type FpJson = any;

fs.mkdirSync(paths.logs, { recursive: true });
const LOG_FILE = path.join(paths.logs, 'fp_calls.log');

export const trace: TraceEntry[] = []; // newest last, capped
let seq = 0;

function record(raw: TraceEntry) {
  const entry = config.demoMode ? raw : { ...raw, body: redact(raw.body), response: redact(raw.response) };
  entry.seq = ++seq;
  trace.push(entry);
  if (trace.length > 400) trace.shift();
  const lines = [
    `\n[${entry.at}] #${entry.seq} ${entry.label ? `(${entry.label}) ` : ''}${entry.method} ${entry.url}`,
    entry.body !== undefined ? `REQUEST ${JSON.stringify(entry.body, null, 2)}` : null,
    `RESPONSE HTTP ${entry.status} (${entry.ms} ms)`,
    typeof entry.response === 'string' ? entry.response.slice(0, 4000) : JSON.stringify(entry.response, null, 2),
  ].filter(Boolean);
  fs.appendFile(LOG_FILE, lines.join('\n') + '\n', () => {});
}

const tokens: Partial<Record<Kind, { value: string; exp: number }>> = {};

async function getToken(kind: Kind): Promise<string> {
  const t = tokens[kind];
  if (t && Date.now() < t.exp) return t.value;
  const c = kind === 'pv' ? config.pv : config.fp;
  const authTenant = kind === 'pv' ? (c as typeof config.pv).authTenant : (c as typeof config.fp).tenant;
  const r = await send(`${c.authBase}/v2/auth/${authTenant}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'client_credentials' }),
  }, { label: `auth token (${kind})`, t0: Date.now() });
  const j = await r.json().catch(() => ({})) as FpObject;
  if (!j.access_token) throw new FpError(`FP auth (${kind}) failed`, r.status, j);
  tokens[kind] = { value: j.access_token, exp: Date.now() + 25 * 60e3 };
  return j.access_token;
}

export class FpError extends Error {
  /** HTTP status; 0 = no response at all. */
  declare status: number;
  declare body: FpJson;
  constructor(message: string, status: number, body: FpJson) {
    super(message);
    this.status = status;
    this.body = body;
  }
  get userMessage(): string {
    if (this.unreachable) return 'Can’t reach the fund platform right now. Please try again in a minute.';
    const e = this.body?.error;
    // "Validation failed. 1 error(s)" says nothing; the field-level message says what to fix
    const field = e?.errors?.[0]?.message;
    const m = (/^validation failed/i.test(e?.message || '') && field ? field[0].toUpperCase() + field.slice(1) + '.' : null) || e?.message || field || this.message;
    if (/cancellation not allowed/i.test(m)) return 'This plan can’t be cancelled until the fund house has activated it.';
    if (/frequency.*not (supported|allowed)/i.test(m)) return 'The fund house does not offer this plan for this fund at a monthly frequency.';
    return m;
  }
  /** No HTTP response at all (connect timeout, DNS, reset): FP was never reached. */
  get unreachable(): boolean { return this.status === 0; }
}

/** For `.catch(orNull)` on lookups: an FP 4xx means "not found", but an unreachable FP must surface as such. */
export const orNull = (e: unknown): null => {
  if (e instanceof FpError && e.unreachable) throw e;
  return null;
};

/** fetch that retries once on a network failure (no response). Undici gives up connecting after 10 s. */
async function send(url: string, init: RequestInit & { method: string }, meta: { label?: string; body?: unknown; t0: number; timeoutMs?: number }): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(meta.timeoutMs ?? REQUEST_TIMEOUT_MS) });
    } catch (e) {
      const why = (e as NetError).cause?.code || (e as NetError).name || (e as NetError).message;
      log.warn(`FP ${init.method} ${url.split('?')[0]} unreachable (${why})${attempt === 0 ? ', retrying' : ''}`);
      if (attempt === 0) { await sleep(1000); continue; }
      record({ at: new Date().toISOString(), label: meta.label, method: init.method, url, body: meta.body, status: 0, ms: Date.now() - meta.t0, response: `NETWORK ERROR: ${why}` });
      throw new FpError(`FP unreachable (${why})`, 0, null);
    }
  }
}

/** A fetch failure: undici puts the socket error code on `cause`. */
type NetError = Error & { cause?: { code?: string } };

async function call(kind: Kind, method: string, p: string, body?: unknown, { label, quiet = false, timeoutMs }: CallOptions = {}): Promise<{ status: number; json: FpJson }> {
  const base = kind === 'pv' ? config.pv.base : config.fp.base;
  const url = base + p;
  const t0 = Date.now();
  let r: Response, txt: string;
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { Authorization: 'Bearer ' + (await getToken(kind)), 'Content-Type': 'application/json' };
    if (kind === 'fp') headers['x-tenant-id'] = config.fp.tenant;
    r = await send(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, { label, body, t0, timeoutMs: timeoutMs ?? (quiet ? POLL_TIMEOUT_MS : REQUEST_TIMEOUT_MS) });
    txt = await r.text();
    if (r.status === 401 && attempt === 0) { delete tokens[kind]; continue; }
    if (r.status !== 429 || attempt >= 8) break;
    await sleep(1500 * (attempt + 1));
  }
  let json: FpJson;
  try { json = JSON.parse(txt!); } catch { json = txt!; }
  if (!quiet) {
    record({ at: new Date().toISOString(), label, method, url, body, status: r!.status, ms: Date.now() - t0, response: json });
  }
  return { status: r!.status, json };
}

/** Throws FpError on non-2xx. */
async function must(kind: Kind, method: string, p: string, body: unknown, opts?: CallOptions): Promise<FpJson> {
  const r = await call(kind, method, p, body, opts);
  if (r.status >= 300) throw new FpError(`${method} ${p} failed (HTTP ${r.status})`, r.status, r.json);
  return r.json;
}

export const fp = {
  get: (p: string, o?: CallOptions) => must('fp', 'GET', p, undefined, o),
  post: (p: string, b: unknown, o?: CallOptions) => must('fp', 'POST', p, b, o),
  patch: (p: string, b: unknown, o?: CallOptions) => must('fp', 'PATCH', p, b, o),
  put: (p: string, b: unknown, o?: CallOptions) => must('fp', 'PUT', p, b, o),
  raw: (m: string, p: string, b?: unknown, o?: CallOptions) => call('fp', m, p, b, o),
};
export const pv = {
  get: (p: string, o?: CallOptions) => must('pv', 'GET', p, undefined, o),
  post: (p: string, b: unknown, o?: CallOptions) => must('pv', 'POST', p, b, o),
};
