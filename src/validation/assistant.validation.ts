import { z } from 'zod';

export const assistantSchemas = {
  ask: {
    body: z.object({
      action: z.literal('book_call').optional(),
      text: z.string().max(500, 'Keep the question under 500 characters.').optional(),
    }),
  },
};
