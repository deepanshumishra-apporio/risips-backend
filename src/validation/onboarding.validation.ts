import { z } from 'zod';
import { ageOf } from '../utils/format.ts';
import { otpCode, txnOtp } from './common.ts';

export const ENUMS = {
  occupation: ['private_sector_service', 'public_sector_service', 'government_service', 'house_wife', 'student', 'business', 'professional', 'retired', 'agriculture', 'service', 'others'],
  income_slab: ['upto_1lakh', 'above_1lakh_upto_5lakh', 'above_5lakh_upto_10lakh', 'above_10lakh_upto_25lakh', 'above_25lakh_upto_1cr', 'above_1cr'],
  marital_status: ['single', 'married', 'others'],
  gender: ['male', 'female', 'transgender'],
} as const;

export const RELATIONSHIPS = ['father', 'mother', 'spouse', 'son', 'daughter', 'brother', 'sister', 'grand_father', 'grand_mother', 'others'] as const;

const INDIVIDUAL_PAN = /^[A-Z]{3}P[A-Z][0-9]{4}[A-Z]$/; // 4th character P = an individual
const ANY_PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const text = (msg: string) => z.string({ error: msg });
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const realDate = (msg: string) => text(msg).trim().refine((d) => ageOf(d) !== null, msg);
const enumOf = (values: readonly string[], msg: string) => z.string({ error: msg }).refine((v) => values.includes(v), msg);
const ifsc = text('Enter a valid IFSC.').trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC.');
/** data:image/png|jpeg;base64 (the service checks the bytes). ~8 MB of image is ~11 MB of base64. */
const image = text('Invalid image.').max(12_000_000, 'Image is too small or too large.').regex(/^data:image\/(png|jpe?g);base64,/, 'Invalid image.');

export const onboardingSchemas = {
  pan: {
    body: z.object({
      pan: text('Enter a valid individual PAN (e.g. ABCPX1234K).').trim().toUpperCase().regex(INDIVIDUAL_PAN, 'Enter a valid individual PAN (e.g. ABCPX1234K).'),
      name: text('Enter your full name as on PAN (letters only).').transform(collapse).refine((n) => /^[A-Za-z][A-Za-z .']{2,69}$/.test(n), 'Enter your full name as on PAN (letters only).'),
      dob: realDate('Enter a valid date of birth (YYYY-MM-DD).'),
      // Sent by app versions that have the fresh-KYC screens; older ones keep the "fresh KYC needed" stop.
      fresh_kyc: z.boolean().optional().default(false),
    }),
  },
  profile: {
    body: z.object({
      occupation: enumOf(ENUMS.occupation, 'Invalid occupation.').optional(),
      income_slab: enumOf(ENUMS.income_slab, 'Invalid income slab.').optional(),
      marital_status: enumOf(ENUMS.marital_status, 'Invalid marital status.').optional(),
      gender: enumOf(ENUMS.gender, 'Invalid gender.').optional(),
      father_name: z.union([z.string(), z.number()]).transform((v) => collapse(String(v)))
        .refine((n) => /^[A-Za-z .']{3,70}$/.test(n), "Enter your father's or spouse's full name.").optional(),
    }),
  },
  pincode: { params: z.object({ pin: z.string().regex(/^\d{6}$/, 'Enter a 6-digit pincode.') }), paramsStatus: 400 },
  address: {
    body: z.object({
      line1: z.string({ error: 'Enter your house / street address.' }).trim().min(3, 'Enter your house / street address.').max(120, 'Address line is too long.'),
      line2: z.string().trim().max(120, 'Address line is too long.').optional().default(''),
      pincode: z.string({ error: 'Enter a 6-digit pincode.' }).regex(/^\d{6}$/, 'Enter a 6-digit pincode.'),
      gender: enumOf(ENUMS.gender, 'Select your gender.'),
    }),
  },
  aadhaarStart: {
    body: z.object({
      aadhaar: z.union([z.string(), z.number()], { error: 'Enter your 12-digit Aadhaar number.' })
        .transform((v) => String(v).replace(/\D/g, '')).refine((a) => /^[2-9]\d{11}$/.test(a), 'Enter your 12-digit Aadhaar number.'),
    }),
  },
  aadhaarVerify: { body: z.object({ code: otpCode }) },
  // The KYC form must be filled from within India (Cybrilla): the phone's location, roughly India's bounding box.
  kycStart: {
    body: z.object({
      latitude: z.number({ error: 'Allow location access to continue.' }).min(6, 'Your KYC must be done from within India.').max(37.5, 'Your KYC must be done from within India.'),
      longitude: z.number({ error: 'Allow location access to continue.' }).min(68, 'Your KYC must be done from within India.').max(97.5, 'Your KYC must be done from within India.'),
    }),
  },
  ifsc: { params: z.object({ ifsc }), paramsStatus: 400 },
  bank: {
    body: z.object({
      account_number: z.union([z.string(), z.number()], { error: 'Account number must be 9–18 digits.' })
        .transform((v) => String(v).replace(/\s/g, '')).refine((a) => /^\d{9,18}$/.test(a), 'Account number must be 9–18 digits.'),
      ifsc,
    }),
  },
  image: { body: z.object({ image }) },
  declarations: {
    body: z.object({
      fatca: z.literal(true, { error: 'Please accept the FATCA / CRS declaration.' }),
      running_account: z.boolean().optional().default(false),
    }),
  },
  nominee: {
    body: z.object({
      skip: z.boolean().optional().default(false),
      name: z.string().optional(),
      dob: z.string().optional(),
      relationship: z.string().optional(),
      pan: z.string().optional(),
      otp: txnOtp,
    }).superRefine((b, ctx) => {
      if (b.skip) return;
      const fail = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
      if (!/^[A-Za-z ]{3,40}$/.test(collapse(b.name || ''))) fail('name', 'Enter the nominee’s full name (letters only).');
      else if (ageOf(b.dob || '') === null) fail('dob', 'Enter a valid date of birth for the nominee (YYYY-MM-DD).');
      else if (!(RELATIONSHIPS as readonly string[]).includes(b.relationship || '')) fail('relationship', 'Select the relationship.');
      else if (!ANY_PAN.test((b.pan || '').toUpperCase().trim())) fail('pan', 'Enter the nominee’s PAN (required as identity proof).');
    }).transform((b) => ({
      ...b,
      name: collapse(b.name || ''),
      dob: b.dob || '',
      relationship: b.relationship || '',
      pan: (b.pan || '').toUpperCase().trim(),
    })),
  },
  esign: { body: z.object({ consent: z.literal(true, { error: 'Please agree to eSign the form.' }) }) },
};
