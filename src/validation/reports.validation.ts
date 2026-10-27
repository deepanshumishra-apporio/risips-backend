import { z } from 'zod';

export const reportsSchemas = {
  report: {
    params: z.object({ key: z.string().regex(/^[a-z-]{2,30}$/, 'Report not found') }),
    query: z.object({
      fy: z.string().regex(/^20\d{2}$/, 'Choose a financial year.').transform(Number).optional(),
      id: z.string().regex(/^[A-Za-z0-9_]{1,80}$/, 'Order not found').optional(),
    }),
  },
};
