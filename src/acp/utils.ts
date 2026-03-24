/**
 * Extract a human-readable error message from an unknown error value.
 */
export function extractReadableError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}
