// KYC onboarding. PAN/name/DOB/KRA-readiness and bank are verified with FP pre-verification.
// On eSign the investor is created in FP: profile -> phone/email/address -> bank -> nominee -> MF account.
import { usersRepo } from '../db/repositories/users.repository.ts';
import { fp, orNull, pv } from '../integrations/fp.client.ts';
import { MfInvestmentAccount, RelatedParty } from '../integrations/fp.schemas.ts';
import { poll } from '../utils/async.ts';
import { ApiError } from '../utils/errors.ts';
import { ageOf } from '../utils/format.ts';
import { log } from '../utils/logger.ts';
import { saveImage } from './files.service.ts';
import { checkLoginOtp, requireTxnOtp, sendAadhaarOtp } from './otp.service.ts';
import { nextStep, publicUser } from './user.service.ts';
import type { BankDetails, FpObject, User, UserData } from '../types/domain.ts';

const READINESS_MSG: Record<string, string> = {
  kyc_unavailable: 'No KYC record found for this PAN with the KRA. A fresh KYC is needed.',
  kyc_rejected: 'Your KYC was rejected by the KRA. A fresh KYC is needed.',
  kyc_incomplete: 'Your KYC is incomplete at the KRA and needs a modification.',
  kyc_onhold: 'Your KYC is on hold at the KRA and needs a modification.',
  kyc_legacy: 'Your KYC is a legacy record and needs a modification.',
  kyc_underprocess: 'Your KYC is still being processed by the KRA. Please try again in a few days.',
  kyc_deactivated: 'Your KYC is deactivated. You cannot invest right now.',
  upstream_error: 'The KRA service is unavailable. Please try again.',
};

/** Once the FP investor exists, the onboarding answers are what FP holds: editing them here would silently diverge. */
export function assertStillOnboarding(user: User) {
  if (user.data.onboarded_at) throw new ApiError(409, 'Your account is already set up. Contact support to change these details.');
}

async function runPreVerification(body: FpObject, { maxMs = 25000 } = {}): Promise<FpObject> {
  const created = await pv.post('/poa/pre_verifications', body, { label: 'pre-verification' });
  const done = await poll(
    () => pv.get(`/poa/pre_verifications/${created.id}`, { quiet: true }),
    (o) => o.status === 'completed' || o.status === 'failed',
    { every: 1500, max: maxMs },
  );
  // record the final state in the trace
  return pv.get(`/poa/pre_verifications/${created.id}`, { label: 'pre-verification result' }).catch(() => done);
}

// ---------- PAN ----------

export async function verifyPan(user: User, { pan, name, dob }: { pan: string; name: string; dob: string }) {
  if (user.data.pan_confirmed) throw new ApiError(409, 'Your PAN is already confirmed and can not be edited.');
  if (ageOf(dob)! < 18) throw new ApiError(400, 'You must be 18 or older to open an account. Investing for a minor is not supported yet.');
  const o = await runPreVerification({
    investor_identifier: pan,
    pan: { value: pan },
    name: { value: name },
    date_of_birth: { value: dob },
  });
  const checks = { readiness: o.readiness, pan: o.pan, name: o.name, date_of_birth: o.date_of_birth };
  const failed = Object.entries(checks).filter(([, v]) => v?.status !== 'verified');
  if (o.status !== 'completed' || failed.length) {
    const [k, v] = failed[0] || ['readiness', {}];
    let msg = 'We could not verify your PAN right now. Please try again.';
    if (v?.code === 'upstream_error') msg = READINESS_MSG.upstream_error; // retryable on any check, never "invalid"
    else if (k === 'readiness' && v?.code) msg = READINESS_MSG[v.code] || msg;
    else if (k === 'pan' && v?.code === 'aadhaar_not_linked') msg = 'Your PAN is not linked with Aadhaar. Link it on the income-tax portal and try again.';
    else if (k === 'pan' && v?.status) msg = 'This PAN is invalid. Please check and re-enter.';
    else if (k === 'name' && v?.status) msg = 'The name does not match PAN records. Enter it exactly as on your PAN card.';
    else if (k === 'date_of_birth' && v?.status) msg = 'The date of birth does not match PAN records.';
    await usersRepo.merge(user.id, { pan_attempt: { pan, pv_id: o.id, checks } });
    throw new ApiError(422, msg, { checks, pv_id: o.id });
  }
  const u = await usersRepo.merge(user.id, { pan, name, dob, pan_verified: true, pan_pv_id: o.id, pan_checks: checks, pan_confirmed: false });
  return { user: publicUser(u), checks, pv_id: o.id };
}

export async function confirmPan(user: User) {
  if (!user.data.pan_verified) throw new ApiError(400, 'Verify your PAN first.');
  return { user: publicUser(await usersRepo.merge(user.id, { pan_confirmed: true })) };
}

export async function resetPan(user: User) {
  if (user.data.pan_confirmed) throw new ApiError(409, 'Your PAN is already confirmed and can not be edited.');
  return { user: publicUser(await usersRepo.merge(user.id, { pan_verified: false, pan_confirmed: false })) };
}

// ---------- profile and address ----------

/** Generic profile fields (occupation, income, marital status, father/spouse name, gender). */
export async function updateProfile(user: User, patch: Partial<Pick<UserData, 'occupation' | 'income_slab' | 'marital_status' | 'gender' | 'father_name'>>) {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  return { user: publicUser(await usersRepo.merge(user.id, clean)) };
}

export async function pincodeLookup(pin: string) {
  const p = await fp.get(`/api/onb/pincodes/${pin}`, { label: 'pincode lookup' }).catch(orNull);
  if (!p?.city && !p?.state_name) throw new ApiError(404, 'Pincode not found.');
  return { city: p.city || p.district, state: p.state_name };
}

export async function saveAddress(user: User, { line1, line2, pincode, gender }: { line1: string; line2: string; pincode: string; gender: string }) {
  const p = await fp.get(`/api/onb/pincodes/${pincode}`, { label: 'pincode lookup' }).catch(orNull);
  if (!p?.city && !p?.state_name) throw new ApiError(400, 'Pincode not found.');
  const address = { line1, line2, pincode, city: p.city || p.district, state: p.state_name };
  return { user: publicUser(await usersRepo.merge(user.id, { address, gender })) };
}

// ---------- Aadhaar (demo) ----------
// FP's KYC/Aadhaar products are not enabled on this tenant, so the OTP is simulated here. Only the last 4 digits are
// stored.

export async function startAadhaar(user: User, aadhaar: string) {
  const sent = await sendAadhaarOtp(user.id);
  await usersRepo.merge(user.id, { aadhaar_pending: aadhaar.slice(-4) });
  return { ok: true, masked: `XXXX XXXX ${aadhaar.slice(-4)}`, ...sent };
}

export async function verifyAadhaar(user: User, code: string) {
  try {
    await checkLoginOtp('aadhaar', String(user.id), code);
  } catch (e) {
    const reason = (e as ApiError).extra?.reason;
    throw new ApiError(400, { wrong: 'Incorrect OTP. Please try again.', locked: 'Too many attempts. Please request a new OTP.' }[reason as 'wrong'] || 'OTP expired. Please request a new one.', { reason });
  }
  const last4 = user.data.aadhaar_pending;
  return { user: publicUser(await usersRepo.merge(user.id, { aadhaar_last4: last4, aadhaar_verified: true, aadhaar_verified_at: new Date().toISOString() })) };
}

// ---------- bank ----------

export async function ifscLookup(ifsc: string) {
  const b = await fp.get(`/api/onb/ifsc_codes/${ifsc}`, { label: 'IFSC lookup' }).catch(orNull);
  if (!b) throw new ApiError(404, 'IFSC not found.');
  return { ifsc, bank_name: b.bank_name || b.bank, branch: b.branch_name || b.branch, city: b.city };
}

export async function verifyBank(user: User, { account_number, ifsc }: { account_number: string; ifsc: string }) {
  const b = await fp.get(`/api/onb/ifsc_codes/${ifsc}`, { label: 'IFSC lookup' }).catch(orNull);
  if (!b) throw new ApiError(400, 'IFSC not found.');
  // Bank verification needs the holder's name + PAN, and PAN checks need name + DOB alongside.
  const d = user.data;
  const o = await runPreVerification({
    pan: { value: d.pan },
    name: { value: d.name },
    date_of_birth: { value: d.dob },
    bank_accounts: [{ value: { account_number, ifsc_code: ifsc, account_type: 'savings' } }],
  }, { maxMs: 20000 });
  const st = o.bank_accounts?.[0];
  const bank: BankDetails = { account_number, ifsc, bank_name: b.bank_name || b.bank, branch: b.branch_name || b.branch, city: b.city, pv_id: o.id, status: st?.status || 'pending', code: st?.code || null };
  if (st?.status !== 'verified') {
    await usersRepo.merge(user.id, { bank_attempt: bank });
    const msg = !st?.status
      ? 'Bank verification is taking longer than usual. Please try again, or use another account.'
      : st.code === 'low_confidence' || st.code === 'uncertain'
        ? 'We could not confirm this account belongs to you. Please use another account in your name.'
        : 'Bank verification failed. Please check the account number and IFSC.';
    throw new ApiError(422, msg, { bank_status: bank.status, code: bank.code, pv_id: o.id });
  }
  bank.verified = true;
  return { user: publicUser(await usersRepo.merge(user.id, { bank })) };
}

// ---------- documents and declarations ----------

export async function saveSelfie(user: User, image: string) {
  const file = saveImage(user.id, 'selfie', image);
  return { user: publicUser(await usersRepo.merge(user.id, { selfie: file, selfie_at: new Date().toISOString() })) };
}

export async function saveSignature(user: User, image: string) {
  const file = saveImage(user.id, 'signature', image);
  return { user: publicUser(await usersRepo.merge(user.id, { signature: file, signature_at: new Date().toISOString() })) };
}

export async function saveDeclarations(user: User, runningAccount: boolean) {
  return { user: publicUser(await usersRepo.merge(user.id, { fatca_declared: true, running_account_auth: runningAccount })) };
}

// SEBI: a nomination, or the declaration opting out of one, is authenticated with an OTP to the registered mobile and
// email (FP: "investor consent has been taken (by OTP 2FA method) to add nomination against the new folio").
export async function saveNominee(user: User, n: { skip: boolean; name: string; dob: string; relationship: string; pan: string; otp?: string | null }) {
  if (n.skip) {
    const consent = await requireTxnOtp(user, 'nominee', n.otp);
    return { user: publicUser(await usersRepo.merge(user.id, { nominee: null, nominee_skipped: true, nominee_consent: { ...consent, opted_out: true } })) };
  }
  if (n.name.toLowerCase() === (user.data.name || '').toLowerCase()) throw new ApiError(400, 'Nominee cannot be yourself.');
  if (ageOf(n.dob)! < 18) throw new ApiError(400, 'Minor nominees need guardian details, which this demo does not collect. Please add an adult nominee or skip.');
  if (n.pan === user.data.pan) throw new ApiError(400, 'Nominee PAN must be different from yours.');
  const consent = await requireTxnOtp(user, 'nominee', n.otp);
  const { name, dob, relationship, pan } = n;
  return { user: publicUser(await usersRepo.merge(user.id, { nominee: { name, dob, relationship, pan }, nominee_skipped: false, nominee_consent: consent })) };
}

/**
 * Profile > Nominee: adds a nominee after onboarding, for an investor who opted out then. FP keeps nominees on the
 * investment account's folio_defaults, which it copies only into folios opened from now on: existing folios keep no
 * nominee (FP has no API to change them; the investor updates those with the fund house or MF Central). The app says so.
 * Changing an existing nominee is not offered: FP can't update a related party's proof once set.
 */
export async function addNomineeLater(user: User, n: { skip: boolean; name: string; dob: string; relationship: string; pan: string; otp?: string | null }) {
  const ids = user.data.fp;
  if (!user.data.onboarded_at || !ids?.invp || !ids.mfia) throw new ApiError(409, 'Please finish setting up your account first.');
  if (user.data.nominee) throw new ApiError(409, 'You already have a nominee. Contact support to change it.');
  if (n.skip) throw new ApiError(400, 'Enter your nominee’s details.');
  if (n.name.toLowerCase() === (user.data.name || '').toLowerCase()) throw new ApiError(400, 'Nominee cannot be yourself.');
  if (ageOf(n.dob)! < 18) throw new ApiError(400, 'Minor nominees need guardian details, which this demo does not collect. Please add an adult nominee.');
  if (n.pan === user.data.pan) throw new ApiError(400, 'Nominee PAN must be different from yours.');
  const consent = await requireTxnOtp(user, 'nominee', n.otp); // after validation, before the first FP write
  const { name, dob, relationship, pan } = n;
  // A retry after a failed account update reuses the related party already created for the same details.
  const pending = user.data.nominee_pending;
  const same = pending && pending.name === name && pending.dob === dob && pending.relationship === relationship && pending.pan === pan;
  let relp = same ? pending.relp : null;
  if (!relp) {
    relp = (await fp.post('/v2/related_parties', { profile: ids.invp, name, relationship, date_of_birth: dob, pan }, { label: 'add nominee', as: RelatedParty })).id;
    await usersRepo.merge(user.id, { nominee_pending: { name, dob, relationship, pan, relp } });
  }
  // PATCH folio_defaults with everything it already holds (contacts, payout bank), so nothing else is cleared
  const acct = await fp.get(`/v2/mf_investment_accounts/${ids.mfia}`, { label: 'nominee: read account', as: MfInvestmentAccount });
  const keep = Object.fromEntries(Object.entries(acct.folio_defaults || {}).filter(([k, v]) => v != null && !/^nominee|^nominations_/.test(k)));
  await fp.patch('/v2/mf_investment_accounts', {
    id: ids.mfia,
    folio_defaults: { ...keep, nominee1: relp, nominee1_allocation_percentage: 100, nominee1_identity_proof_type: 'pan', nominations_info_visibility: 'show_all_nominee_names' },
  }, { label: 'nominee: add to new folios', as: MfInvestmentAccount });
  const u = await usersRepo.merge(user.id, {
    nominee: { name, dob, relationship, pan }, nominee_skipped: false, nominee_consent: consent, nominee_added_at: consent.at,
    fp: { ...ids, relp }, nominee_pending: undefined,
  });
  log.info('Nominee added after onboarding', { uid: user.id });
  return { user: publicUser(u) };
}

// ---------- eSign: create the investor in FP ----------

const ESIGN_GATE: Record<string, string> = {
  mobile: 'mobile number', pin: 'PIN', pan: 'PAN', 'pan-confirm': 'PAN', occupation: 'occupation', income: 'annual income',
  marital: 'marital status', father: "father's / spouse's name", address: 'address and gender', aadhaar: 'Aadhaar',
  bank: 'bank account', 'selfie-intro': 'selfie', 'signature-consent': 'signature', nominee: 'nominee',
};

/** Idempotent: resumes from any step that already succeeded (each FP id is saved as soon as it exists). */
export async function esign(u: User, ip: string) {
  const d = u.data;
  if (d.onboarded_at) return { user: publicUser(u), fp: d.fp }; // already done: a double tap or a retry
  const step = nextStep(d);
  if (step !== 'esign') throw new ApiError(400, `Please complete the ${ESIGN_GATE[step] || step} step first.`, { next_step: step });
  if (!u.mobile) throw new ApiError(400, 'Please verify your mobile number first.', { next_step: 'mobile' });
  const ids = { ...(d.fp || {}) };
  const save = () => usersRepo.merge(u.id, { fp: ids });

  if (!ids.invp) {
    const prof = await fp.post('/v2/investor_profiles', {
      type: 'individual',
      tax_status: 'resident_individual',
      name: d.name,
      date_of_birth: d.dob,
      gender: d.gender, // required by the address step (never guessed)
      occupation: d.occupation,
      pan: d.pan,
      country_of_birth: 'IN',
      place_of_birth: d.address!.city || 'IN',
      nationality_country: 'IN',
      citizenship_countries: ['IN'],
      father_name: d.father_name,
      marital_status: d.marital_status,
      use_default_tax_residences: false,
      first_tax_residency: { country: 'IN', taxid_type: 'pan', taxid_number: d.pan },
      source_of_wealth: ['business', 'professional'].includes(d.occupation!) ? 'business' : 'salary',
      income_slab: d.income_slab,
      pep_details: 'not_applicable',
      ip_address: ip,
    }, { label: 'create investor profile' });
    ids.invp = prof.id; await save();
  }
  if (!ids.phone) { ids.phone = (await fp.post('/v2/phone_numbers', { profile: ids.invp, isd: '91', number: u.mobile, belongs_to: 'self' }, { label: 'add phone' })).id; await save(); }
  if (!ids.email) { ids.email = (await fp.post('/v2/email_addresses', { profile: ids.invp, email: u.email, belongs_to: 'self' }, { label: 'add email' })).id; await save(); }
  if (!ids.addr) {
    ids.addr = (await fp.post('/v2/addresses', { profile: ids.invp, line1: d.address!.line1, line2: d.address!.line2 || undefined, postal_code: d.address!.pincode, country: 'IN', nature: 'residential' }, { label: 'add address' })).id;
    await save();
  }
  if (!ids.bank) {
    const bank = await fp.post('/v2/bank_accounts', { profile: ids.invp, primary_account_holder_name: d.name, account_number: d.bank!.account_number, type: 'savings', ifsc_code: d.bank!.ifsc }, { label: 'add bank account' });
    ids.bank = bank.id; ids.bank_old_id = bank.old_id; await save();
  }
  if (d.nominee && !ids.relp) {
    ids.relp = (await fp.post('/v2/related_parties', { profile: ids.invp, name: d.nominee.name, relationship: d.nominee.relationship, date_of_birth: d.nominee.dob, pan: d.nominee.pan }, { label: 'add nominee' })).id;
    await save();
  }
  if (!ids.mfia) {
    const folio_defaults = {
      communication_email_address: ids.email,
      communication_mobile_number: ids.phone,
      communication_address: ids.addr,
      payout_bank_account: ids.bank,
      ...(ids.relp
        ? { nominee1: ids.relp, nominee1_allocation_percentage: 100, nominee1_identity_proof_type: 'pan', nominations_info_visibility: 'show_all_nominee_names' }
        : { nominations_info_visibility: 'show_nomination_status' }),
    };
    const acct = await fp.post('/v2/mf_investment_accounts', { primary_investor: ids.invp, holding_pattern: 'single', folio_defaults }, { label: 'create MF investment account' });
    ids.mfia = acct.id; ids.mfia_old_id = acct.old_id; await save();
  }
  const done = await usersRepo.merge(u.id, { fp: ids, onboarded_at: new Date().toISOString(), esign_consent_at: new Date().toISOString() });
  log.info('Investor onboarded', { uid: u.id });
  return { user: publicUser(done), fp: ids };
}

export const kycForm = (user: User) => ({ user: publicUser(user), generated_at: new Date().toISOString() });
