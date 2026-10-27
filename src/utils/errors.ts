// An error with an HTTP status and an investor-facing message. Anything else that reaches the error handler is a 500
// with a generic message (the details go to the log only).

export class ApiError extends Error {
  declare status: number;
  /** Extra fields for the JSON error body (e.g. reason, checks), read by the app. */
   
  declare extra: Record<string, any>;
   
  constructor(status: number, message: string, extra: Record<string, any> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Errors from MF Central, the sandbox and fetch carry an optional HTTP status. */
export type StatusError = Error & { status?: number };
