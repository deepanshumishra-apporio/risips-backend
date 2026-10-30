// Shapes the user record for the app and decides the next onboarding step.
import { signedFileUrl } from './files.service.ts';
import { maskTail } from '../utils/mask.ts';
import type { User, UserData } from '../types/domain.ts';

/**
 * KYC-compliant = FP pre-verification found a valid KYC record for the PAN at the KRA. Such an investor needs no fresh
 * KYC, so the Aadhaar and signature steps (the documents for a new KYC) are skipped. A PAN with no KRA record goes on
 * with a fresh KYC (`kyc_fresh`, kyc.service.ts); the PAN step turns away every other readiness result.
 */
export const kycCompliant = (d: UserData) => d.pan_checks?.readiness?.status === 'verified';

/**
 * For the app: `compliant` (can invest), `in_progress` (fresh KYC being filled in), `with_kra` (submitted, waiting for
 * the KRA, usually 1-3 working days), `failed` (the form failed or expired: redo it), or null before the PAN step.
 */
export function kycStatus(d: UserData): string | null {
  if (kycCompliant(d)) return 'compliant';
  if (!d.kyc_fresh) return null;
  const s = d.kyc_form?.status;
  if (s === 'submitted') return 'with_kra';
  if (s === 'failed' || s === 'expired') return 'failed';
  return 'in_progress';
}

export function nextStep(d: UserData): string {
  if (d.onboarded_at) return 'home'; // onboarded users never go back into the flow, even if a later rule is added
  if (!d.mobile_verified) return 'mobile';
  if (!d.pin_set) return 'pin';
  if (!d.pan_verified) return 'pan';
  if (!d.pan_confirmed) return 'pan-confirm';
  if (!d.occupation) return 'occupation';
  if (!d.income_slab) return 'income';
  if (!d.marital_status) return 'marital';
  if (!d.father_name) return 'father';
  if (!d.address || !d.gender) return 'address'; // the address screen also collects gender (FP profile needs it)
  const kyc = kycCompliant(d);
  if (!kyc && !d.aadhaar_verified) return 'aadhaar'; // fresh KYC: DigiLocker
  if (!d.bank?.verified) return 'bank';
  // No selfie for a fresh KYC: the DigiLocker Aadhaar OTP is the liveness check (Cybrilla KYC Forms)
  if (!kyc && !d.kyc_fresh && !d.selfie) return 'selfie-intro';
  if (!d.fatca_declared || (!kyc && !d.signature)) return 'signature-consent'; // FATCA/CRS is needed either way
  // the investor e-signs the KYC form, which Cybrilla then submits to the KRA
  if (!kyc && d.kyc_fresh && !['awaiting_submission', 'submitted'].includes(d.kyc_form?.status || '')) return 'kyc-esign';
  if (!d.nominee_consent) return 'nominee'; // a nomination or an opt-out, confirmed with an OTP
  if (!d.onboarded_at) return 'esign';
  return 'home';
}

export function publicUser(u: User) {
  const d = u.data || {};
  return {
    id: u.id,
    email: u.email,
    mobile: u.mobile,
    name: d.name || null,
    first_name: d.name ? d.name.split(' ')[0] : null,
    dob: d.dob || null,
    gender: d.gender || null,
    // the full PAN never leaves the server (TC 115): the app shows what the investor typed, or this
    pan_masked: maskTail(d.pan, 3),
    aadhaar_masked: d.aadhaar_last4 ? `XXXX XXXX ${d.aadhaar_last4}` : null,
    occupation: d.occupation || null,
    income_slab: d.income_slab || null,
    marital_status: d.marital_status || null,
    father_name: d.father_name || null,
    address: d.address || null,
    bank: d.bank ? { ...d.bank, account_masked: maskTail(d.bank.account_number, 4), account_number: undefined } : null,
    nominee: d.nominee ? { ...d.nominee, pan: maskTail(d.nominee.pan, 3) } : null,
    nominee_skipped: !!d.nominee_skipped,
    nominee_added_at: d.nominee_added_at || null,
    kyc_compliant: kycCompliant(d),
    kyc_fresh: !!d.kyc_fresh,
    kyc_status: kycStatus(d),
    selfie_url: signedFileUrl(d.selfie),
    signature_url: signedFileUrl(d.signature),
    biometric: !!d.biometric,
    pin_set: !!d.pin_set,
    onboarded: !!d.onboarded_at,
    onboarded_at: d.onboarded_at || null,
    member_since: u.created_at?.slice(0, 4),
    next_step: nextStep(d),
    fp: d.fp ? { investor_profile: d.fp.invp, investment_account: d.fp.mfia } : null,
  };
}
