import { z } from 'zod';
import { TXN_ACTION_KEYS } from '../services/otp.service.ts';

export const otpSchemas = {
  txnOtp: { body: z.object({ action: z.enum(TXN_ACTION_KEYS, { error: 'Unknown action.' }) }) },
};
