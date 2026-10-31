/** Error thrown by ops-engine for rejected operations; `code` is machine-readable. */
export class OpsError extends Error {
  readonly code: string;
  readonly detail?: Record<string, unknown>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "OpsError";
    this.code = code;
    if (detail) this.detail = detail;
  }
}
