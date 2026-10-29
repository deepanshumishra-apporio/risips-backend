import { z } from 'zod';
import { fpIdParam } from './common.ts';

/** Query values the caller left empty (?kind=) count as absent, as in the JS backend. */
const optional = <T extends z.ZodType>(t: T) => z.preprocess((v) => (v === '' || v == null ? undefined : v), t.optional());

/** limit 1-200 (default 50) and offset >= 0: out-of-range values are clamped, not refused. */
const paging = {
  limit: z.unknown().optional().transform((v) => Math.min(Math.max(Number(v) || 50, 1), 200)),
  offset: z.unknown().optional().transform((v) => Math.max(Math.floor(Number(v)) || 0, 0)),
};

/** YYYY-MM-DD that is a real calendar day (2026-02-31 is refused). */
const day = (k: string) => z.string().refine((d) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}, `${k} must be a date as YYYY-MM-DD.`);

export const ORDER_KINDS = ['purchase', 'redemption', 'switch', 'sip', 'stp', 'swp'] as const;

export const adminSchemas = {
  investors: {
    query: z.object({
      q: optional(z.string().trim().toLowerCase().max(100)),
      stage: optional(z.string().regex(/^[a-z_-]{1,40}$/, 'Unknown stage.')),
      ...paging,
    }),
  },
  investorId: {
    params: z.object({ id: z.string().regex(/^[1-9]\d{0,9}$/, 'No such investor.').transform(Number).refine((n) => n <= 2147483647, 'No such investor.') }),
  },
  orders: {
    query: z.object({
      kind: optional(z.enum(ORDER_KINDS, { error: `kind must be one of ${ORDER_KINDS.join(', ')}.` })),
      state: optional(z.string().regex(/^[a-z_]{1,40}$/, 'Unknown state.')),
      user_id: optional(z.string().regex(/^\d{1,10}$/, 'user_id must be a positive whole number.').transform(Number)
        .refine((n) => n >= 1 && n <= 2147483647, 'user_id must be a positive whole number.')),
      from: optional(day('from')),
      to: optional(day('to')),
      ...paging,
    }),
  },
  orderId: { params: fpIdParam(['mfp', 'mfr', 'mfs', 'mfpp', 'mfsp', 'mfrp'], 'No such order.') },
};
