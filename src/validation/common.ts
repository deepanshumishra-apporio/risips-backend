// Field schemas shared by the feature schemas. Messages are what the app shows the investor.
import { z } from 'zod';

/** AMFI-accepted TLDs (see backend_fp_reference.md). */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.(com|in|org|co|net|edu|me|uk)$/i;

export const email = z.string({ error: 'Enter a valid email address.' }).trim().toLowerCase().max(254, 'Enter a valid email address.')
  .regex(EMAIL_RE, 'Enter a valid email address.');

/** A 10-digit Indian mobile; accepts +91 / spaces / dashes and keeps the last 10 digits. */
export const mobile = z.union([z.string(), z.number()], { error: 'Enter a valid 10-digit mobile number.' })
  .transform((v) => String(v).replace(/\D/g, '').slice(-10))
  .refine((m) => /^[6-9]\d{9}$/.test(m) && !/^(\d)\1{9}$/.test(m), 'Enter a valid 10-digit mobile number.');

/** A one-time code as typed (string or number). */
export const otpCode = z.union([z.string(), z.number()], { error: 'Enter the code we sent you.' })
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{4,8}$/.test(v), 'Enter the code we sent you.');

/** The 2FA code on a transaction. Optional here: the service answers `otp_required` so the app can ask for it. */
export const txnOtp = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).optional().nullable();

export const pin = z.union([z.string(), z.number()], { error: 'PIN must be 4 digits.' })
  .transform((v) => String(v)).refine((v) => /^\d{4}$/.test(v), 'PIN must be 4 digits.');

export const isin = z.string({ error: 'Choose a fund.' }).trim().toUpperCase().regex(/^IN[A-Z0-9]{10}$/, 'Fund not found');

/** A rupee amount as a number or a numeric string. */
export const amount = z.union([z.number(), z.string().trim().regex(/^\d+(\.\d+)?$/)], { error: 'Enter an amount.' })
  .transform(Number)
  .refine((n) => Number.isFinite(n) && n > 0 && n <= 1e9, 'Enter an amount.');

/** A day of the month for SIP / STP / SWP instalments. */
export const day = z.union([z.number(), z.string().regex(/^\d{1,2}$/)], { error: 'Choose a date between 1 and 28.' })
  .transform(Number).refine((d) => Number.isInteger(d) && d >= 1 && d <= 28, 'Choose a date between 1 and 28.');

export const folio = z.string({ error: 'Folio is required.' }).trim().min(1, 'Folio is required.').max(40, 'Folio is required.')
  .regex(/^[A-Za-z0-9/ -]+$/, 'Folio is required.');

/** yyyy-mm-dd */
export const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date (YYYY-MM-DD).');

export const yesNo = z.boolean({ error: 'Must be true or false.' });

/** FP object ids in route params: mfp_…, mfpp_…, chk_… */
export const fpIdParam = (prefixes: string[], notFound: string) =>
  z.object({ id: z.string().regex(new RegExp(`^(${prefixes.join('|')})_[A-Za-z0-9]{1,64}$`), notFound) });

/** An empty or absent body. Unknown fields are ignored. */
export const noBody = z.object({}).optional();
