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
import type { FpModel } from './fp.schemas.ts';

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
/** `as`: the model of the reply (fp.schemas.ts). The reply is checked against it and typed by it. */
export type TypedOptions<T> = CallOptions & { as?: FpModel<T> };
const REQUEST_TIMEOUT_MS = 45000;
const POLL_TIMEOUT_MS = 10000;
/** FP's reply to an endpoint without a model: JSON when it parses, else the raw text. Prefer a model (`as`). */

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
  /** A 2xx reply that lacks what its model requires (fp.schemas.ts `core`). */
  declare malformed: boolean;
  constructor(message: string, status: number, body: FpJson, { malformed = false } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.malformed = malformed;
  }
  get userMessage(): string {
    if (this.unreachable) return 'Can’t reach the fund platform right now. Please try again in a minute.';
    // FP may have acted on the request (an order created), so say to look before trying again
    if (this.malformed) return 'The fund platform sent an unexpected reply. Please check Orders before trying again.';
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

/** Fields that differ from the model, logged once per model + field (FP changing a shape shows up without flooding). */
const drift = new Set<string>();

/**
 * Checks an FP reply against its model and returns it typed (unchanged: unmodelled fields are kept). Missing `core`
 * fields throw a `malformed` FpError; any other mismatch is logged once and let through.
 */
export function asModel<T>(m: FpModel<T>, json: unknown, { label, status = 200 }: { label?: string; status?: number } = {}): T {
  const core = m.core.safeParse(json);
  if (!core.success) {
    const where = core.error.issues.map((i) => `${i.path.join('.') || '(reply)'}: ${i.message}`).slice(0, 5).join('; ');
    log.error(`FP sent an unexpected ${m.name}`, { label, where });
    throw new FpError(`FP sent an unexpected ${m.name} (${where})`, status, null, { malformed: true });
  }
  const full = m.full.safeParse(json);
  if (!full.success) {
    for (const i of full.error.issues) {
      // array indexes vary from reply to reply; the field is what matters
      const key = `${m.name}:${i.path.filter((x) => typeof x !== 'number').join('.')}`;
      if (drift.has(key)) continue;
      drift.add(key);
      log.warn(`FP ${m.name} differs from its documented shape`, { label, field: i.path.join('.'), problem: i.message });
    }
  }
  return json as T;
}

/** asModel for a best-effort read (a status refresh): null instead of a throw when the reply lacks its core fields. */
export function asModelOrNull<T>(m: FpModel<T>, json: unknown, o: { label?: string; status?: number } = {}): T | null {
  try {
    return asModel(m, json, o);
  } catch {
    return null;
  }
}

/** Throws FpError on non-2xx, and (with `as`) on a reply without its model's core fields. */
async function must<T>(kind: Kind, method: string, p: string, body: unknown, opts?: TypedOptions<T>): Promise<T> {
  const r = await call(kind, method, p, body, opts);
  if (r.status >= 300) throw new FpError(`${method} ${p} failed (HTTP ${r.status})`, r.status, r.json);
  return opts?.as ? asModel(opts.as, r.json, { label: opts.label || `${method} ${p.split('?')[0]}`, status: r.status }) : r.json;
}

// T defaults to FpJson (untyped) for endpoints without a model; pass `as` to get a checked, typed reply.
export const fp = {
  get: <T = FpJson>(p: string, o?: TypedOptions<T>) => must<T>('fp', 'GET', p, undefined, o),
  post: <T = FpJson>(p: string, b: unknown, o?: TypedOptions<T>) => must<T>('fp', 'POST', p, b, o),
  patch: <T = FpJson>(p: string, b: unknown, o?: TypedOptions<T>) => must<T>('fp', 'PATCH', p, b, o),
  put: <T = FpJson>(p: string, b: unknown, o?: TypedOptions<T>) => must<T>('fp', 'PUT', p, b, o),
  /** Any status, no throw: check `status` yourself, then asModel() the json. */
  raw: (m: string, p: string, b?: unknown, o?: CallOptions) => call('fp', m, p, b, o),
};
export const pv = {
  get: <T = FpJson>(p: string, o?: TypedOptions<T>) => must<T>('pv', 'GET', p, undefined, o),
  post: <T = FpJson>(p: string, b: unknown, o?: TypedOptions<T>) => must<T>('pv', 'POST', p, b, o),
  patch: <T = FpJson>(p: string, b: unknown, o?: TypedOptions<T>) => must<T>('pv', 'PATCH', p, b, o),
  upload: (p: string, file: { bytes: Buffer; name: string; type: string }, o?: CallOptions) => uploadPv(p, file, o),
};

/** A multipart file upload to the pre-verification API (KYC form signature). The trace shows the file name only. */
async function uploadPv(p: string, file: { bytes: Buffer; name: string; type: string }, { label }: CallOptions = {}): Promise<FpJson> {
  const url = config.pv.base + p;
  const t0 = Date.now();
  let r: Response;
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
    r = await send(url, { method: 'POST', headers: { Authorization: 'Bearer ' + (await getToken('pv')) }, body: form }, { label, t0 });
    if (r.status === 401 && attempt === 0) { delete tokens.pv; continue; }
    break;
  }
  const txt = await r.text();
  let json: FpJson;
  try { json = JSON.parse(txt); } catch { json = txt; }
  record({ at: new Date().toISOString(), label, method: 'POST', url, body: { file: file.name }, status: r.status, ms: Date.now() - t0, response: json });
  if (r.status >= 300) throw new FpError(`POST ${p} failed (HTTP ${r.status})`, r.status, json);
  return json;
}
