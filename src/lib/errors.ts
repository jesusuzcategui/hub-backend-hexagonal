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
