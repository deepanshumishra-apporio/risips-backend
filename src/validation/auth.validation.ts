import { z } from 'zod';
import { email, mobile, otpCode, pin } from './common.ts';

export const authSchemas = {
  emailStart: { body: z.object({ email }) },
  emailVerify: { body: z.object({ email, code: otpCode }) },
  mobileStart: { body: z.object({ mobile }) },
  mobileVerify: { body: z.object({ mobile, code: otpCode, bank_consent: z.boolean().optional().default(false) }) },
  pinSet: { body: z.object({ pin }) },
  pinVerify: { body: z.object({ pin }) },
  biometric: { body: z.object({ enabled: z.boolean({ error: 'Must be true or false.' }) }) },
};
