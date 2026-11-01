export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
export const notFound = (what: string, id?: string) =>
  new ApiError(404, "NOT_FOUND", id ? `${what} ${id} not found` : `${what} not found`);
export const badRequest = (message: string, details?: unknown) => new ApiError(400, "BAD_REQUEST", message, details);
export const conflict = (message: string, code = "CONFLICT") => new ApiError(409, code, message);
