import { z } from 'zod';
import { pin, txnOtp } from './common.ts';
import { DELETION_REASONS, NOTIFY_KEYS } from '../services/settings.service.ts';
import { onboardingSchemas } from './onboarding.validation.ts';

export const settingsSchemas = {
  /** Profile > Nominee: the same fields and checks as the onboarding nominee step. */
  nominee: onboardingSchemas.nominee,
  notifyPrefs: {
    body: z.record(z.string(), z.unknown()).superRefine((b, ctx) => {
      for (const [k, v] of Object.entries(b)) {
        if (!(NOTIFY_KEYS as string[]).includes(k)) ctx.addIssue({ code: 'custom', path: [k], message: `Unknown preference "${k}".` });
        else if (typeof v !== 'boolean') ctx.addIssue({ code: 'custom', path: [k], message: `"${k}" must be true or false.` });
      }
    }).transform((b) => b as Partial<Record<(typeof NOTIFY_KEYS)[number], boolean>>),
  },
  pinCheck: { body: z.object({ current: pin }) },
  pinChange: { body: z.object({ current: pin, pin }) },
  device: { params: z.object({ id: z.string().regex(/^\d{1,12}$/, 'That device is already signed out.').transform(Number) }) },
  deletion: {
    body: z.object({
      reason: z.enum(DELETION_REASONS, { error: 'Unknown reason.' }).nullable().optional().transform((v) => v ?? null),
      otp: txnOtp,
    }),
  },
};

export const notificationsSchemas = {
  read: { body: z.object({ ids: z.array(z.union([z.string(), z.number()]).transform(String)).max(500).optional() }) },
  seen: { body: z.object({ id: z.union([z.string(), z.number()]).transform(String).optional().default('') }) },
};
