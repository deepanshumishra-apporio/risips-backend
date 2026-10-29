// Shapes the user record for the app and decides the next onboarding step.
import { signedFileUrl } from './files.service.ts';
import { maskTail } from '../utils/mask.ts';
import type { User, UserData } from '../types/domain.ts';

/**
 * KYC-compliant = FP pre-verification found a valid KYC record for the PAN at the KRA. Such an investor needs no fresh
 * KYC, so the Aadhaar, selfie and signature steps (the documents for a new KYC) are skipped. The PAN step turns away
 * every other readiness result for now, since fresh KYC isn't offered yet.
 */
export const kycCompliant = (d: UserData) => d.pan_checks?.readiness?.status === 'verified';

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
  if (!kyc && !d.aadhaar_verified) return 'aadhaar';
  if (!d.bank?.verified) return 'bank';
  if (!kyc && !d.selfie) return 'selfie-intro';
  if (!d.fatca_declared || (!kyc && !d.signature)) return 'signature-consent'; // FATCA/CRS is needed either way
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
    pan_masked: maskTail(d.pan, 3),
    pan: d.pan || null,
    aadhaar_masked: d.aadhaar_last4 ? `XXXX XXXX ${d.aadhaar_last4}` : null,
    occupation: d.occupation || null,
    income_slab: d.income_slab || null,
    marital_status: d.marital_status || null,
    father_name: d.father_name || null,
    address: d.address || null,
    bank: d.bank ? { ...d.bank, account_masked: maskTail(d.bank.account_number, 4), account_number: undefined } : null,
    nominee: d.nominee || null,
    nominee_skipped: !!d.nominee_skipped,
    nominee_added_at: d.nominee_added_at || null,
    kyc_compliant: kycCompliant(d),
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
