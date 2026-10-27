// Request validation with zod. Routes declare a schema for body / query / params; the parsed values (types coerced,
// unknown fields dropped) are put on req.valid and read in the controller with valid(req, schema).
// A failure is a 400 with the first problem as `error` (the app shows it) and every problem under `fields`; a bad
// path parameter (a malformed id in the URL) is a 404, since no such resource can exist.
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../utils/errors.ts';

export interface RequestSchema {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
  /** Status for a bad path parameter: 404 (default) for ids, 400 for input like a pincode. */
  paramsStatus?: number;
}

type Out<T> = T extends z.ZodType ? z.output<T> : undefined;
export type Validated<S extends RequestSchema> = { body: Out<S['body']>; query: Out<S['query']>; params: Out<S['params']> };

function check(schema: z.ZodType, value: unknown, status = 400) {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  throw new ApiError(status, r.error.issues[0]?.message || 'Invalid request.', { reason: 'validation', fields });
}

export const validate = (schema: RequestSchema) => (req: Request, _res: Response, next: NextFunction) => {
  const params = schema.params ? check(schema.params, req.params, schema.paramsStatus ?? 404) : undefined;
  const query = schema.query ? check(schema.query, req.query) : undefined;
  const body = schema.body ? check(schema.body, req.body ?? {}) : undefined;
  req.valid = { body, query, params };
  next();
};

/** The validated input of a request, typed by the schema the route used. */
export const valid = <S extends RequestSchema>(req: Request, _schema: S) => {
  if (!req.valid) throw new Error('valid() called on a route without validate()');
  return req.valid as Validated<S>;
};
