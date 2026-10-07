export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    /** Optional machine-readable payload returned to the client under `error.details`. */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** The JSON body every AppError is serialized to. */
export function appErrorBody(err: AppError): { error: { code: string; message: string; details?: unknown } } {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    },
  };
}

/**
 * `errorResponseBuilder` for @fastify/rate-limit. The plugin throws whatever the builder returns, so it must be an
 * Error carrying a statusCode; returning a plain object makes the app's error handler answer 500 INTERNAL_ERROR.
 * The plugin still sets the `retry-after` and `x-ratelimit-*` headers before throwing.
 */
export function rateLimitedError(): AppError {
  return new AppError(429, "RATE_LIMITED", "Too many requests. Try again later.");
}
