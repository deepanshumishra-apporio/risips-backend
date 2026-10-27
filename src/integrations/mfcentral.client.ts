// MF Central (CAMS + KFintech) CAS API for distributors: fetch an investor's mutual fund holdings across every fund
// house with the investor's consent. The client (an ARN holder) gets credentials after signing MF Central's LOI and
// "MFC - API Sharing Agreement" (see CLAUDE.md "MF Central"). Until then MFC_* is unset and services/external.service.ts
// uses the local sandbox (mfcentral.sandbox.ts) instead.
//
// Wire format (MFCENTRAL API SPECIFICATIONS & INTEGRATION DOCUMENT, v1):
//   token   POST {base}/oauth/token  Basic b64(clientId:clientSecret), form username/password/grant_type=password
//   calls   POST {base}/api/client/V1/<endpoint>  headers ClientId + Bearer, body {request, signature}
//           request   = AES-256-CBC/PKCS5 of the JSON. Key = the first 32 hex chars of SHA-256(encryptionDecryptionKey),
//                       used as 32 UTF-8 bytes; IV = "globalaesvectors"; base64 with + -> -, / -> _
//           signature = JWS RS256 over the encrypted text, detached, unencoded payload (b64=false), kid from the JWK
//   reply   {response, signature}: verify with MF Central's public JWK, then decrypt the same way
//
// The current partner flow is "v2" (MF Central's hosted SSR journey, mfc-cas.mfcentral.com): starting a request
// returns a redirectUrl; the investor enters MF Central's OTP there, picks what to share and generates a QR code; the
// hosted page hands the QR to our WebView (postMessage "mfc-cas-download") and finishes with "mfc-cas-complete"; we
// send the QR back to MF Central, which releases the CAS for getcasdocument (422 "in process" until it is ready).
// MF Central gives the v2 endpoint names to partners only (CAS API document v2.2), so each one is overridable from
// .env. The defaults are the v1 names.
import crypto from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { log } from '../utils/logger.ts';
import type { StatementLine } from '../types/external.ts';
import type { JsonObject } from '../types/domain.ts';

const env = (k: string, d = '') => process.env[k] || d;

export const mfcConfig = () => ({
  base: env('MFC_BASE_URL', 'https://uatservices.mfcentral.com').replace(/\/$/, ''),
  clientId: env('MFC_CLIENT_ID'),
  clientSecret: env('MFC_CLIENT_SECRET'),
  username: env('MFC_USERNAME'),
  password: env('MFC_PASSWORD'),
  aesKey: env('MFC_AES_KEY'),
  iv: env('MFC_AES_IV', 'globalaesvectors'),
  privateJwk: env('MFC_PRIVATE_JWK'), // ours (JSON), from onboarding
  publicJwk: env('MFC_PUBLIC_JWK'), // MF Central's (JSON), to verify replies
  ep: {
    summary: env('MFC_EP_SUMMARY', 'submitcassummaryrequest'),
    detail: env('MFC_EP_DETAIL', 'submitcasdetailrequest'),
    consent: env('MFC_EP_CONSENT', 'investorconsent'),
    qr: env('MFC_EP_VALIDATE_QR', 'validateqr'),
    document: env('MFC_EP_DOCUMENT', 'getcasdocument'),
  },
});

export const mfcConfigured = () => {
  const c = mfcConfig();
  return !!(c.clientId && c.clientSecret && c.username && c.password && c.aesKey && c.privateJwk && c.publicJwk);
};

export class MfcError extends Error {
  declare status: number;
  declare body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// ---------- crypto (exactly as the spec's CryptUtils / ThirdPartyUtils) ----------

const aesKey = (shared: string) => Buffer.from(crypto.createHash('sha256').update(shared, 'utf8').digest('hex').slice(0, 32), 'utf8');

export function encrypt(text: string, shared = mfcConfig().aesKey, iv = mfcConfig().iv) {
  const c = crypto.createCipheriv('aes-256-cbc', aesKey(shared), Buffer.from(iv, 'utf8'));
  return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

export function decrypt(text: string, shared = mfcConfig().aesKey, iv = mfcConfig().iv) {
  const d = crypto.createDecipheriv('aes-256-cbc', aesKey(shared), Buffer.from(iv, 'utf8'));
  const raw = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return Buffer.concat([d.update(raw), d.final()]).toString('utf8');
}

const b64u = (buf: string | Uint8Array) => Buffer.from(buf).toString('base64url');

/** JWS RS256, detached compact serialisation with an unencoded payload (RFC 7797, jose4j b64=false). */
export function sign(payload: string, jwkJson: string | JsonWebKey = mfcConfig().privateJwk) {
  const jwk = typeof jwkJson === 'string' ? JSON.parse(jwkJson) : jwkJson;
  const header = { alg: 'RS256', ...(jwk.kid ? { kid: jwk.kid } : {}), b64: false };
  const h = b64u(JSON.stringify(header));
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${payload}`, 'utf8'), key);
  return `${h}..${b64u(sig)}`;
}

export function verify(payload: string, jws: unknown, jwkJson: string | JsonWebKey = mfcConfig().publicJwk) {
  const [h, , s] = String(jws || '').split('.');
  if (!h || !s) return false;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  if (header.alg !== 'RS256') return false;
  const jwk = typeof jwkJson === 'string' ? JSON.parse(jwkJson) : jwkJson;
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  // b64=false signs the raw payload; a classic JWS signs its base64url form
  const input = header.b64 === false ? payload : b64u(payload);
  return crypto.verify('RSA-SHA256', Buffer.from(`${h}.${input}`, 'utf8'), key, Buffer.from(s, 'base64url'));
}

// ---------- transport ----------

let token: { value: string; exp: number } | null = null;

async function getToken(): Promise<string> {
  if (token && Date.now() < token.exp) return token.value;
  const c = mfcConfig();
  const r = await fetch(`${c.base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ username: c.username, password: c.password, grant_type: 'password' }),
    signal: AbortSignal.timeout(20e3),
  });
  const j = await r.json().catch(() => ({})) as JsonObject;
  if (!r.ok || !j.access_token) throw new MfcError('MF Central sign-in failed', r.status, { error: j.error, error_description: j.error_description });
  // tokens are long-lived (the spec's sample: 30 days); renew a little early
  token = { value: j.access_token, exp: Date.now() + Math.max(60, Math.min(Number(j.expires_in) || 3600, 86400) - 60) * 1000 };
  return token.value;
}

/** One signed + encrypted call. Returns { status, data } with data decrypted (and its signature checked). */
export async function call(endpoint: string, body: JsonObject): Promise<{ status: number; data: JsonObject }> {
  const c = mfcConfig();
  const request = encrypt(JSON.stringify(body));
  const signature = sign(request);
  const t0 = Date.now();
  const r = await fetch(`${c.base}/api/client/V1/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ClientId: c.clientId, Authorization: `Bearer ${await getToken()}` },
    body: JSON.stringify({ request, signature }),
    signal: AbortSignal.timeout(45e3),
  });
  if (r.status === 401 || r.status === 403) token = null; // expired or revoked: next call signs in again
  const raw = await r.json().catch(() => ({})) as JsonObject;
  let data = raw;
  if (typeof raw.response === 'string' && raw.response) {
    if (!verify(raw.response, raw.signature)) throw new MfcError('MF Central reply failed signature check', r.status, {});
    const txt = decrypt(raw.response);
    try { data = JSON.parse(txt); } catch { data = { text: txt }; }
  }
  // never log PAN, mobile or holdings: only the endpoint, status and timing
  log.info(`MF Central ${endpoint} -> ${r.status} (${Date.now() - t0} ms)`);
  return { status: r.status, data };
}

const errText = (d: JsonObject | null | undefined) => d?.errors?.[0]?.message || d?.message || d?.error || d?.details || null;

// ---------- the CAS journey ----------

/**
 * Starts a request. MF Central sends the investor an OTP on the given mobile or email (only one, as the spec
 * requires). v2 returns `redirectUrl` (the hosted OTP + QR journey); v1 returned `otpRef` for an in-app OTP instead.
 */
export async function startRequest({ clientRefNo, pan, mobile, email, detailed = false, fromDate, toDate }: {
  clientRefNo: string; pan: string; mobile?: string | null; email?: string | null; detailed?: boolean; fromDate?: string; toDate?: string;
}) {
  const c = mfcConfig();
  const body = { clientRefNo, pan, pekrn: '', mobile: mobile ? `+91${mobile.replace(/\D/g, '').slice(-10)}` : '', email: mobile ? '' : email || '' };
  if (detailed) Object.assign(body, { fromDate, toDate });
  const { status, data } = await call(detailed ? c.ep.detail : c.ep.summary, body);
  if (status >= 400) throw new MfcError(errText(data) || 'MF Central did not accept the request', status, data);
  return {
    reqId: data.reqId ?? data.requestId ?? null,
    redirectUrl: data.redirectUrl || data.redirectURL || data.url || null,
    otpRef: data.otpRef || null,
    userSubjectReference: data.userSubjectReference || '',
  };
}

/** v1 only: the OTP typed into our own screen. */
export async function submitOtp({ reqId, otpRef, userSubjectReference, clientRefNo, otp }: { reqId: string; otpRef: string; userSubjectReference: string; clientRefNo: string; otp: string }) {
  const { status, data } = await call(mfcConfig().ep.consent, { reqId, otpRef, userSubjectReference, clientRefNo, enteredOtp: otp });
  if (status >= 400) throw new MfcError(errText(data) || 'OTP was not accepted', status, data);
  return data;
}

/** v2: the QR code (base64 PNG) the investor generated on MF Central's page; releases the CAS for getcasdocument. */
export async function submitQr({ reqId, clientRefNo, qrCode }: { reqId: string | null; clientRefNo: string; qrCode: string }) {
  const { status, data } = await call(mfcConfig().ep.qr, { reqId, clientRefNo, qrCode });
  if (status >= 400) throw new MfcError(errText(data) || 'MF Central did not accept the QR code', status, data);
  return data;
}

/** null while MF Central is still preparing it (422 "We are in process of generating the CAS"). */
export async function fetchDocument({ reqId, clientRefNo }: { reqId: string | null; clientRefNo: string }): Promise<JsonObject | null> {
  const { status, data } = await call(mfcConfig().ep.document, { reqId, clientRefNo });
  if (status === 422 || data?.errors?.[0]?.code === '422') return null;
  if (status >= 400) throw new MfcError(errText(data) || 'MF Central could not return the statement', status, data);
  return data;
}

// ---------- CAS JSON -> statement lines (external.ts shape) ----------

const n = (x: unknown) => { const v = Number(String(x ?? '').replace(/,/g, '')); return Number.isFinite(v) ? v : 0; };
const MON: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
/** '14-Jun-2022' -> '2022-06-14' */
export const casDate = (s: unknown): string | null => {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || '').trim());
  return m ? `${m[3]}-${MON[m[2].toUpperCase()]}-${m[1].padStart(2, '0')}` : null;
};
const broker = (code: unknown) => {
  const c = String(code || '').trim();
  if (!c || /^direct$/i.test(c) || /^0+$/.test(c)) return 'DIRECT';
  return /^\d+$/.test(c) ? `ARN-${c}` : c.toUpperCase();
};

/**
 * Cost of the units still held, first-in first-out, from a detailed CAS's transactions (the detailed format has no
 * cost column). Units in = purchases / switch-ins / reinvested dividends; units out = redemptions / switch-outs.
 */
export function fifoCost(txns: JsonObject[]) {
  const lots: { units: number; cost: number }[] = [];
  for (const t of [...txns].sort((a, b) => String(casDate(a.trxnDate)).localeCompare(String(casDate(b.trxnDate))))) {
    const units = n(t.trxnUnits);
    const amount = Math.abs(n(t.trxnAmount));
    const out = units < 0 || /redempt|switch.?out|transfer.?out|withdraw/i.test(t.trxnDesc || '');
    if (!units) continue;
    if (!out) { lots.push({ units: Math.abs(units), cost: amount }); continue; }
    let left = Math.abs(units);
    while (left > 1e-6 && lots.length) {
      const lot = lots[0];
      const take = Math.min(lot.units, left);
      lot.cost -= lot.cost * (take / lot.units);
      lot.units -= take;
      left -= take;
      if (lot.units <= 1e-6) lots.shift();
    }
  }
  return lots.reduce((a, l) => a + l.cost, 0);
}

/** Summary CAS (schemes[] with costValue) or detailed CAS (dtSummary[] + dtTransaction[]) -> statement lines. */
export function normaliseCas(doc: JsonObject | null | undefined) {
  const blocks = Array.isArray(doc?.data) ? doc.data : [doc?.data || doc];
  const lines: StatementLine[] = [];
  let investor: JsonObject | null = null;
  for (const b of blocks) {
    if (!b) continue;
    if (b.investorDetails) investor = b.investorDetails;
    for (const s of b.schemes || []) {
      const units = n(s.closingBalance) || n(s.availableUnits);
      if (!s.isin || units <= 0) continue;
      lines.push({
        isin: String(s.isin).trim(), folio: String(s.folio ?? '').trim(), scheme_name: String(s.schemeName || "").trim(), amc_name: s.amcName,
        registrar: null, units, cost_value: n(s.costValue), nav: n(s.nav), nav_date: casDate(s.navDate), value: n(s.currentMktValue),
        broker: null, plan: s.planMode ? (/direct/i.test(s.planMode) ? 'Direct Plan' : 'Regular Plan') : null, demat: s.isDemat === 'Y',
      });
    }
    const tx = b.dtTransaction || [];
    for (const s of b.dtSummary || []) {
      const units = n(s.closingBalance);
      if (!s.isin || units <= 0) continue;
      const mine = tx.filter((t: JsonObject) => String(t.folio).trim() === String(s.folio).trim() && (t.scheme === s.scheme || t.schemeName === s.schemeName));
      lines.push({
        isin: String(s.isin).trim(), folio: String(s.folio ?? '').trim(), scheme_name: String(s.schemeName || "").trim(), amc_name: s.amcName,
        registrar: null, units, cost_value: mine.length ? fifoCost(mine) : 0, nav: n(s.nav), nav_date: casDate(s.lastNavDate),
        value: n(s.marketValue), broker: broker(s.brokerCode), plan: /direct/i.test(s.schemeName || '') ? 'Direct Plan' : null, demat: s.isDemat === 'Y',
      });
    }
  }
  return { lines, investor };
}
