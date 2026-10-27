// What the middleware puts on the request.
import type { User } from './domain.ts';

declare global {
   
  namespace Express {
    interface Request {
      /** Set by `requireAuth`. */
      user: User;
      /** The raw session token (only for comparisons; never stored or logged). */
      token: string;
      /** Set by the request-id middleware; echoed in the X-Request-Id header and in logs. */
      id: string;
      /** Parsed and checked by `validate()`; read with `valid(req, schema)`. */
      valid?: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}

export {};
