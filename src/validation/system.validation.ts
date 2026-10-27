import { z } from 'zod';
import { FILE_NAME_RE } from '../services/files.service.ts';

export const systemSchemas = {
  file: {
    params: z.object({ name: z.string().regex(FILE_NAME_RE, 'Not found') }),
    query: z.object({
      exp: z.string().regex(/^\d{10}$/).transform(Number),
      sig: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  },
  trace: { query: z.object({ since: z.string().regex(/^\d{1,12}$/).transform(Number).optional().default(0) }) },
};
