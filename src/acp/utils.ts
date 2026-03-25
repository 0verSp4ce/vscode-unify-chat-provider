import type { ContentBlock } from "@agentclientprotocol/sdk";

/**
 * Extract a human-readable error message from an unknown error value.
 */
export function extractReadableError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}

/**
 * Extract text from an ACP ContentBlock, returning `undefined` for
 * non-text or missing blocks.
 */
export function getContentText(content?: ContentBlock): string | undefined {
  if (!content) return undefined;
  if (content.type === "text") return content.text;
  return undefined;
}
