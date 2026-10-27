// Import funds held outside Risips ("Import external funds", Figma 8:7638 / 8:7678; Portfolio 8:4001 / 8:4083) from
// MF Central's CAS API (../mfcentral.ts), or from the local sandbox (../mfc-sandbox.ts) while the client's MF Central
// credentials are pending and DEMO_MODE is on. Valuation and storage: ../external.ts.
//
//   POST /external/start {via, mobile|email, consent, pan?}  -> { journey_url }   MF Central sends the investor an OTP
//   (app opens journey_url in a WebView: OTP -> choose data -> QR; the page posts the QR back to the app)
//   POST /external/qr {qr}                                   -> importing          we hand the QR to MF Central
//   GET  /external                                           -> status (polls MF Central while importing)
// A background sweep keeps polling every minute, so funds appear even if the investor closes the app.
import crypto from 'node:crypto';
import { config } from '../config/env.ts';
import { extImportsRepo } from '../db/repositories/misc.repository.ts';
import { usersRepo } from '../db/repositories/users.repository.ts';
import * as mfc from '../integrations/mfcentral.client.ts';
import * as sandbox from '../integrations/mfcentral.sandbox.ts';
import { ApiError } from '../utils/errors.ts';
import type { StatusError } from '../utils/errors.ts';
import { errMsg, log } from '../utils/logger.ts';
import type { ExtState, JsonObject, User } from '../types/domain.ts';
import type { ExtImport } from '../types/external.ts';

const extStore = {
  get: (userId: number) => extImportsRepo.get<ExtImport>(userId),
  save: (userId: number, data: ExtImport) => extImportsRepo.save(userId, data),
  drop: (userId: number) => extImportsRepo.drop(userId),
};

/** What the import routes need from MF Central (or the local sandbox). */
interface ProviderApi {
  startRequest(b: { clientRefNo: string; pan: string; mobile?: string | null; email?: string | null }): Promise<{ reqId: string | null; redirectUrl: string | null }>;
  submitQr(b: { reqId: string | null; clientRefNo: string; qrCode: string }): Promise<unknown>;
  fetchDocument(b: { reqId: string | null; clientRefNo: string }): Promise<JsonObject | null>;
}

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GIVE_UP_MS = 60 * 60e3; // MF Central says 10-15 min; after an hour the request is treated as lost

/** The consent text the investor accepts (stored with the time and IP, as MF Central's agreement requires). */
export const CONSENT_TEXT = 'I authorise Risips to fetch my mutual fund holdings from MF Central (CAMS and KFintech) using an OTP sent to my registered mobile or email, to show them in my Risips portfolio.';
const CONSENT_VERSION = '2026-10-13';

function provider(): { name: string; api: ProviderApi } | null {
  if (mfc.mfcConfigured()) return { name: 'mfcentral', api: mfc };
  if (config.demoMode) return { name: 'sandbox', api: { ...sandbox, startRequest: (b: Parameters<ProviderApi['startRequest']>[0]) => sandbox.startRequest(b, { publicUrl: config.publicUrl }) } };
  return null;
}

/** users.data.ext = { status, hidden, pan, error, request, consent }; status: none | otp_sent | importing | ready | failed */
export const setExt = (userId: number, patch: Partial<ExtState>) => usersRepo.update(userId, (d) => ({ ext: { ...(d.ext || {}), ...patch } }));

const maskMobile = (m: string | null) => (m ? `+91 ******${String(m).slice(-4)}` : null);
const maskEmail = (e: string | null) => (e ? e.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.max(1, b.length)) + c) : null);
const maskPan = (p: string | null | undefined) => (p ? `${p.slice(0, 2)}*****${p.slice(-3)}` : null);

async function statusView(user: User) {
  const st = user.data.ext || {};
  const imp = await extStore.get(user.id);
  const p = provider();
  return {
    status: st.status || (imp ? 'ready' : 'none'),
    provider: p?.name || null,
    available: !!p,
    pan: user.data.pan || st.pan || null,
    pan_masked: maskPan(user.data.pan || st.pan),
    pan_locked: !!user.data.pan,
    mobile: user.mobile || null,
    email: user.email || null,
    request: st.request ? { started_at: st.request.started_at, qr_at: st.request.qr_at || null, sent_to: st.request.sent_to } : null,
    error: st.status === 'failed' ? st.error || 'The import did not complete. Please try again.' : null,
    imported_at: imp?.imported_at || null,
    as_of: imp?.as_of || null,
    count: imp?.holdings?.length || 0,
    sample: !!imp?.sample,
    hidden: !!st.hidden,
    consent_text: CONSENT_TEXT,
  };
}

/** Polls MF Central for a request whose QR was handed over; stores the statement once it is ready. */
async function advance(userId: number) {
  const user = await usersRepo.byId(userId);
  const st = user?.data.ext;
  if (st?.status !== 'importing' || !st.request) return;
  const p = provider();
  if (!p || p.name !== st.request.provider) {
    await setExt(userId, { status: 'failed', error: 'The import was started on another connection. Please start again.' });
    return;
  }
  let doc: JsonObject | null;
  try {
    doc = await p.api.fetchDocument({ reqId: st.request.req_id, clientRefNo: st.request.client_ref });
  } catch (e) {
    log.warn('MF Central fetch failed', { uid: userId, err: errMsg(e) });
    if ((e as StatusError).status && (e as StatusError).status! < 500 && (e as StatusError).status !== 429) await setExt(userId, { status: 'failed', error: 'MF Central could not return your statement. Please try again.' });
    return;
  }
  if (!doc) {
    if (Date.now() - st.request.qr_at! > GIVE_UP_MS) await setExt(userId, { status: 'failed', error: 'MF Central has not sent your statement. Please try again.' });
    return;
  }
  const { lines } = mfc.normaliseCas(doc);
  const asOf = lines.map((l) => l.nav_date).filter(Boolean).sort().pop() || new Date().toISOString().slice(0, 10);
  await extStore.save(userId, {
    source: p.name, sample: !!doc.sample, as_of: asOf, imported_at: new Date().toISOString(), req_id: st.request.req_id,
    holdings: lines,
  });
  await setExt(userId, { status: 'ready', error: null, request: { ...st.request, done_at: Date.now() } });
  log.info(`MF Central import done: ${lines.length} scheme lines via ${p.name}`, { uid: userId });
}

export async function status(user: User) {
  await advance(user.id);
  return statusView((await usersRepo.byId(user.id))!);
}

export async function startImport(user: User, ip: string, b: { via: 'mobile' | 'email'; consent: true; pan?: string; mobile?: string; email?: string }) {
  const p = provider();
  if (!p) throw new ApiError(503, 'Importing from MF Central isn’t switched on yet. Please try again later.');
  const { via } = b;
  // the PAN on the investor's KYC; someone who hasn't finished onboarding types it (and it is kept for later imports)
  const pan = user.data.pan || b.pan || user.data.ext?.pan;
  if (!pan || !PAN_RE.test(pan)) throw new ApiError(400, 'Please enter a valid PAN, e.g. ABCDE1234F.');
  let mobile: string | null = null;
  let email: string | null = null;
  if (via === 'email') {
    email = String(b.email || user.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'Please enter a valid email address.');
  } else {
    mobile = String(b.mobile || user.mobile || '').replace(/\D/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(mobile)) throw new ApiError(400, 'Please enter a valid 10-digit mobile number.');
  }
  const clientRef = `RSP${user.id}T${Date.now()}${crypto.randomBytes(2).toString('hex')}`.toUpperCase();
  let started: Awaited<ReturnType<ProviderApi['startRequest']>>;
  try {
    started = await p.api.startRequest({ clientRefNo: clientRef, pan, mobile, email });
  } catch (e) {
    const err = e as StatusError;
    const msg = /invalid pan and (mobile|email)/i.test(err.message)
      ? `MF Central has no folios for this PAN with that ${via === 'email' ? 'email' : 'mobile number'}. Try the ${via === 'email' ? 'mobile number' : 'email'} registered with your funds.`
      : err.status === 429 ? 'Too many attempts. Please try again in a few minutes.' : 'MF Central didn’t accept the request. Please try again.';
    log.warn('MF Central start failed', { uid: user.id, status: err.status, err: err.message });
    throw new ApiError(err.status! >= 500 || !err.status ? 502 : 400, msg);
  }
  if (!started.redirectUrl) {
    log.error('MF Central returned no redirectUrl', { keys: Object.keys(started).join(',') });
    throw new ApiError(502, 'MF Central didn’t return its verification page. Please try again later.');
  }
  await setExt(user.id, {
    status: 'otp_sent', error: null, pan: user.data.pan ? undefined : pan,
    consent: { text: CONSENT_TEXT, version: CONSENT_VERSION, at: new Date().toISOString(), ip, via },
    request: {
      provider: p.name, client_ref: clientRef, req_id: started.reqId, started_at: Date.now(),
      sent_to: mobile ? maskMobile(mobile) : maskEmail(email), journey_url: started.redirectUrl,
    },
  });
  return { journey_url: started.redirectUrl, provider: p.name, sent_to: mobile ? maskMobile(mobile) : maskEmail(email) };
}

/** The QR the investor generated on MF Central's page (base64 PNG, from the WebView's "mfc-cas-download" message). */
export async function submitQr(user: User, b: { qr: string; req_id?: string; extent?: string | null }) {
  const st = user.data.ext;
  if (!st?.request || !['otp_sent', 'failed'].includes(st.status!) || st.request.qr_at) {
    if (st?.status === 'importing') return await statusView(user); // a second Continue tap
    throw new ApiError(409, 'Please start the import again.');
  }
  const qr = b.qr;
  const p = provider();
  if (!p || p.name !== st.request.provider) throw new ApiError(409, 'Please start the import again.');
  try {
    await p.api.submitQr({ reqId: b.req_id || st.request.req_id, clientRefNo: st.request.client_ref, qrCode: qr });
  } catch (e) {
    const err = e as StatusError;
    log.warn('MF Central QR rejected', { uid: user.id, status: err.status, err: err.message });
    throw new ApiError(err.status! >= 500 || !err.status ? 502 : 400, 'MF Central didn’t accept the QR code. Please start the import again.');
  }
  await setExt(user.id, { status: 'importing', error: null, request: { ...st.request, qr_at: Date.now(), extent: b.extent || null } });
  return statusView((await usersRepo.byId(user.id))!);
}

/** Leaving MF Central's page without finishing. */
export async function cancelImport(user: User) {
  if (user.data.ext?.status === 'otp_sent') await setExt(user.id, { status: (await extStore.get(user.id)) ? 'ready' : 'none', request: null });
  return statusView((await usersRepo.byId(user.id))!);
}

export async function setHidden(user: User, hidden: boolean) {
  await setExt(user.id, { hidden });
  return { ok: true, hidden };
}

/** Removes every imported fund (the investor can import again any time). */
export async function removeImport(user: User) {
  await extStore.drop(user.id);
  await setExt(user.id, { status: 'none', error: null, request: null, hidden: false });
  return statusView((await usersRepo.byId(user.id))!);
}

/** Background poll for every import waiting on MF Central. */
export async function sweepImports() {
  for (const id of await usersRepo.importingIds()) await advance(id).catch((e) => log.warn('MF Central sweep failed', { uid: id, err: errMsg(e) }));
}

/** MF Central's page, opened outside a WebView, ends by redirecting here; the app's WebView intercepts this URL. */
export const RETURN_PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
  <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#020b1b;color:#fff;font-family:sans-serif;text-align:center">
  <div><h2>Returning to Risips…</h2><p style="opacity:.6">You can close this window.</p></div>`;
