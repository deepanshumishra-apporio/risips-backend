// Fresh KYC for a PAN the KRA has no record of (pre-verification readiness `kyc_unavailable`), through Cybrilla POA's
// KYC Forms API (poa.cybrilla.com/docs/additional-apis/kyc-forms, "early access"). Same host and token as
// pre-verification. Sandbox-verified end to end 2026-10-30 (kycf_7e7ad655…: created -> DigiLocker -> e-sign -> submitted).
//
// Flow: the Aadhaar step creates the form, fills it with the onboarding answers and sends the investor to DigiLocker
// (Aadhaar = identity + address proof; its OTP also counts as liveness, so no selfie). The signature step uploads the
// signature to the form. The kyc-esign step has the investor e-sign the filled form, after which Cybrilla submits it
// to the KRA. Orders wait until the KRA shows the PAN as compliant (1-3 working days): a job re-checks it.
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config/env.ts';
import { usersRepo } from '../db/repositories/users.repository.ts';
import { FpError, pv } from '../integrations/fp.client.ts';
import { poll } from '../utils/async.ts';
import { ApiError } from '../utils/errors.ts';
import { errMsg, log } from '../utils/logger.ts';
import { publicUser } from './user.service.ts';
import type { FpObject, KycFormState, User, UserData } from '../types/domain.ts';

/** A form that can still be completed (anything else is replaced by a new one). */
const LIVE = ['under_review', 'created', 'awaiting_esign', 'awaiting_submission', 'submitted'];
const RETURN = () => `${config.publicUrl}/kyc/return`;
/** Our onboarding answers use FP profile values; the KYC form spells two of them differently. */
const OCCUPATION: Record<string, string> = { house_wife: 'housewife' };
const MARITAL: Record<string, string> = { single: 'unmarried' };
const FAIL_TEXT: Record<string, string> = {
  ineligible_for_fresh_kyc: 'A fresh KYC can’t be submitted for this PAN. Please contact support.',
};

export async function runPreVerification(body: FpObject, { maxMs = 25000 } = {}): Promise<FpObject> {
  const created = await pv.post('/poa/pre_verifications', body, { label: 'pre-verification' });
  const done = await poll(
    () => pv.get(`/poa/pre_verifications/${created.id}`, { quiet: true }),
    (o) => o.status === 'completed' || o.status === 'failed',
    { every: 1500, max: maxMs },
  );
  // record the final state in the trace
  return pv.get(`/poa/pre_verifications/${created.id}`, { label: 'pre-verification result' }).catch(() => done);
}

const stateOf = (f: FpObject): KycFormState => ({
  id: f.id,
  status: f.status,
  reason: f.reason ?? null,
  proof_status: f.proof_details?.status ?? null,
  fields_needed: f.requirements?.fields_needed ?? null,
  signature_provided: !!f.signature_provided,
  esign_status: f.esign_details?.status ?? null,
  expires_at: f.expires_at ?? null,
  submitted_at: f.submitted_at ?? null,
});

export function kycFailText(k: KycFormState | undefined): string | null {
  if (!k || (k.status !== 'failed' && k.status !== 'expired')) return null;
  if (k.status === 'expired') return 'Your KYC form expired before it was finished. Please start again.';
  return FAIL_TEXT[k.reason || ''] || `Your KYC form was not accepted${k.reason ? ` (${k.reason.replace(/_/g, ' ')})` : ''}. Please check your details and start again.`;
}

/** Everything the form needs from onboarding, in the form's own values. */
function details(u: User, geo: { latitude: number; longitude: number }) {
  const d = u.data;
  const married = d.marital_status === 'married';
  return {
    email_address: u.email,
    phone_number: { isd: '+91', number: u.mobile },
    residential_status: 'resident',
    gender: d.gender,
    marital_status: MARITAL[d.marital_status!] || d.marital_status,
    // the onboarding asks for "father's or spouse's name": the form wants the spouse for a married investor
    ...(married ? { spouse_name: d.father_name } : { father_name: d.father_name }),
    occupation_type: OCCUPATION[d.occupation!] || d.occupation,
    country_of_birth: 'in',
    place_of_birth: d.address?.city || 'India', // as on the FP investor profile (onboarding.service.ts esign)
    income_slab: d.income_slab,
    pep_details: 'no_exposure',
    citizenship_countries: ['in'],
    nationality_country: 'in',
    tax_residency_other_than_india: false, // the FATCA/CRS declaration says the same
    geolocation: geo,
  };
}

/** Uploads the signature already saved with us, if the form still needs one. */
async function syncSignature(u: User, form: FpObject): Promise<FpObject> {
  if (!u.data.signature || form.signature_provided || !(form.requirements?.fields_needed || []).includes('signature')) return form;
  const name = u.data.signature;
  const bytes = fs.readFileSync(path.join(paths.uploads, name));
  return pv.upload(`/poa/kyc_forms/${form.id}/signature`, { bytes, name, type: name.endsWith('.png') ? 'image/png' : 'image/jpeg' }, { label: 'KYC form: signature' });
}

/** Saves the form's state and what follows from it (Aadhaar fetched, form lost). Returns the updated user. */
async function store(u: User, form: FpObject): Promise<User> {
  const k = stateOf(form);
  const patch: Partial<UserData> = { kyc_form: k };
  if (k.proof_status === 'fetched' && !u.data.aadhaar_verified) {
    patch.aadhaar_verified = true;
    patch.aadhaar_verified_at = new Date().toISOString();
    if (/\d{4}$/.test(form.aadhaar_number || '')) patch.aadhaar_last4 = String(form.aadhaar_number).slice(-4);
  }
  // A failed or expired form has to be redone from DigiLocker on a new form (the signature is re-sent automatically).
  if (!LIVE.includes(k.status)) patch.aadhaar_verified = false;
  return usersRepo.merge(u.id, patch);
}

function requireFresh(u: User) {
  if (!u.data.kyc_fresh) throw new ApiError(409, 'Your KYC is already on record with the KRA.');
}

/**
 * The Aadhaar step: creates the KYC form (or reuses the live one), fills it, and returns the DigiLocker link.
 * `geo` is the phone's location: the form must be filled from within India.
 */
export async function startKyc(user: User, geo: { latitude: number; longitude: number }) {
  requireFresh(user);
  const d = user.data;
  if (!d.pan_confirmed || !d.address || !d.gender || !d.father_name || !d.occupation || !d.income_slab || !d.marital_status) {
    throw new ApiError(400, 'Please complete your personal details first.');
  }
  let form: FpObject | null = null;
  if (d.kyc_form && LIVE.includes(d.kyc_form.status)) form = await pv.get(`/poa/kyc_forms/${d.kyc_form.id}`, { label: 'KYC form' });
  if (!form || !LIVE.includes(form.status)) {
    form = await pv.post('/poa/kyc_forms', {
      type: 'fresh', pan: d.pan, name: d.name, date_of_birth: d.dob,
      proof_details_callback_url: `${RETURN()}?step=proof`, esign_callback_url: `${RETURN()}?step=esign`,
    }, { label: 'KYC form: create' });
    await usersRepo.merge(user.id, { kyc_form: stateOf(form!), aadhaar_verified: false });
  }
  // Cybrilla checks the PAN's eligibility first (a few seconds)
  if (form!.status === 'under_review') {
    const id = form!.id;
    form = await poll(() => pv.get(`/poa/kyc_forms/${id}`, { quiet: true }), (f) => f?.status !== 'under_review', { every: 1500, max: 20000 });
  }
  if (form!.status === 'created' && (form!.requirements?.fields_needed || []).some((f: string) => !['address', 'identity_proof', 'signature'].includes(f))) {
    form = await pv.patch('/poa/kyc_forms', { id: form!.id, ...details(user, geo) }, { label: 'KYC form: details' });
  }
  if (form!.status === 'created') form = await syncSignature(user, form!); // a redo on a new form: the signature is on file
  const u = await store(user, form!);
  const k = u.data.kyc_form!;
  if (k.status === 'under_review') throw new ApiError(503, 'Your KYC form is still being checked. Please try again in a minute.');
  const failed = kycFailText(k);
  if (failed) throw new ApiError(422, failed, { kyc_status: k.status, reason: k.reason });
  if (k.proof_status === 'fetched') return { user: publicUser(u), fetch_url: null };
  const fetchUrl = form!.proof_details?.fetch_url;
  if (!fetchUrl) throw new ApiError(502, 'DigiLocker is not available right now. Please try again.');
  return { user: publicUser(u), fetch_url: fetchUrl, return_url_prefix: RETURN() };
}

/** Re-reads the form after DigiLocker or e-sign (the app calls it when the investor comes back). */
export async function refreshKyc(user: User) {
  requireFresh(user);
  const id = user.data.kyc_form?.id;
  if (!id) throw new ApiError(400, 'Start your KYC from the Aadhaar step first.');
  let form = await pv.get(`/poa/kyc_forms/${id}`, { label: 'KYC form' });
  form = await syncSignature(user, form);
  const u = await store(user, form);
  return { user: publicUser(u), kyc: u.data.kyc_form, error: kycFailText(u.data.kyc_form) };
}

/** Called by the signature step: sends the saved signature to the live KYC form. */
export async function uploadKycSignature(user: User) {
  const id = user.data.kyc_form?.id;
  if (!user.data.kyc_fresh || !id || !LIVE.includes(user.data.kyc_form!.status)) return user;
  const form = await syncSignature(user, await pv.get(`/poa/kyc_forms/${id}`, { label: 'KYC form' }));
  return store(user, form);
}

/** The kyc-esign step: the e-sign link for the filled form. */
export async function kycEsign(user: User) {
  let { user: pu, kyc, error } = await refreshKyc(user);
  // Cybrilla moves a complete form to awaiting_esign a moment after its last field (the signature) arrives: a check
  // straight after the signature step still sees `created` (sandbox 2026-10-30: 0.2 s after the upload)
  if (kyc?.status === 'created' && kyc.signature_provided && !kyc.fields_needed?.length) {
    const id = kyc.id;
    const form = await poll(() => pv.get(`/poa/kyc_forms/${id}`, { quiet: true }), (f) => f?.status !== 'created', { every: 1000, max: 10000 });
    const u = await store(user, form);
    ({ user: pu, kyc, error } = { user: publicUser(u), kyc: u.data.kyc_form, error: kycFailText(u.data.kyc_form) });
  }
  if (error) throw new ApiError(422, error, { kyc_status: kyc?.status });
  if (kyc?.status === 'awaiting_submission' || kyc?.status === 'submitted') return { user: pu, esign_url: null };
  if (kyc?.status !== 'awaiting_esign') {
    const missing = (kyc?.fields_needed || []).join(', ');
    throw new ApiError(400, `Your KYC form is not complete yet${missing ? ` (missing: ${missing.replace(/_/g, ' ')})` : ''}.`, { next_step: pu.next_step });
  }
  const form = await pv.get(`/poa/kyc_forms/${kyc.id}`, { label: 'KYC form' });
  const url = form.esign_details?.esign_url;
  if (!url) throw new ApiError(502, 'The e-sign page is not available right now. Please try again.');
  return { user: pu, esign_url: url, return_url_prefix: RETURN() };
}

/**
 * After submission: asks the KRA (pre-verification readiness) whether the PAN is compliant now. When it is, the stored
 * readiness turns `verified` and the investor can place orders. Throttled to once per 10 minutes per investor.
 */
export async function checkKra(user: User, { force = false } = {}): Promise<User> {
  const d = user.data;
  if (!d.kyc_fresh || d.kyc_approved_at || !d.pan) return user;
  if (!force && d.kyc_checked_at && Date.now() - Date.parse(d.kyc_checked_at) < 10 * 60e3) return user;
  const o = await runPreVerification({ investor_identifier: d.pan, pan: { value: d.pan }, name: { value: d.name }, date_of_birth: { value: d.dob } });
  const now = new Date().toISOString();
  if (o.readiness?.status === 'verified') {
    log.info('Fresh KYC approved by the KRA', { uid: user.id });
    return usersRepo.merge(user.id, { kyc_checked_at: now, kyc_approved_at: now, pan_checks: { ...(d.pan_checks || {}), readiness: o.readiness } });
  }
  return usersRepo.merge(user.id, { kyc_checked_at: now });
}

/** The KYC status screen / home banner: refreshes the form and the KRA status. */
export async function kycStatus(user: User) {
  let u = user;
  if (u.data.kyc_form && LIVE.includes(u.data.kyc_form.status) && u.data.kyc_form.status !== 'submitted') {
    u = await store(u, await pv.get(`/poa/kyc_forms/${u.data.kyc_form.id}`, { label: 'KYC form' }));
  }
  if (u.data.kyc_form?.status === 'submitted') u = await checkKra(u);
  return { user: publicUser(u), kyc: u.data.kyc_form || null, error: kycFailText(u.data.kyc_form) };
}

/** Job: investors whose fresh KYC is with the KRA, checked until it shows as compliant. */
export async function sweepPendingKyc() {
  for (const id of await usersRepo.pendingKycIds()) {
    const u = await usersRepo.byId(id);
    if (!u) continue;
    try {
      await checkKra(u);
    } catch (e) {
      log.warn('KRA status check failed', { uid: id, err: e instanceof FpError ? e.userMessage : errMsg(e) });
    }
  }
}
