import { z } from 'zod';
import { isin } from './common.ts';

/** A single query-string value (a repeated parameter arrives as an array and is refused). */
const q = (max = 100) => z.string({ error: 'Invalid filter.' }).max(max, 'Invalid filter.').optional();

export const fundsSchemas = {
  list: {
    query: z.object({
      q: q(), collection: q(30), category: q(200), risk: q(200), top: q(5), sort: q(5), picks: q(5),
      amc_id: z.string().regex(/^\d{1,6}$/, 'Invalid filter.').transform(Number).optional(),
      switch_in: q(5), stp_in: q(5),
    }),
  },
  compare: {
    query: z.object({
      // the compare screen is two funds side by side (Figma): a third is refused, not silently dropped
      isins: z.string({ error: 'Fund not found' }).max(60).transform((v) => v.split(',').filter(Boolean))
        .pipe(z.array(isin).min(1, 'Fund not found').max(2, 'You can compare up to 2 funds.')),
    }),
  },
  detail: { params: z.object({ isin }), query: z.object({ period: q(5) }) },
  watch: { params: z.object({ isin }) },
};
