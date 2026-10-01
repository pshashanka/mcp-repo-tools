import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Stable, machine-readable error codes. Agents branch on these, so treat them
 * as public API: add new codes freely, never rename or repurpose existing ones.
 */
export const ErrorCode = {
  InvalidInput: "INVALID_INPUT",
  PathDenied: "PATH_DENIED",
  NotFound: "NOT_FOUND",
  TooLarge: "TOO_LARGE",
  InvalidRef: "INVALID_REF",
  ToolDisabled: "TOOL_DISABLED",
  Timeout: "TIMEOUT",
  GitError: "GIT_ERROR",
  Internal: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** An expected failure whose message is safe to show to the model. */
export class ToolError extends Error {
  override readonly name = "ToolError";

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Converts any thrown value into an MCP error result.
 *
 * Only `ToolError` messages reach the client; anything else is reported as
 * INTERNAL with a generic message so stack traces and host paths don't leak.
 * The code is in both the text (for models) and `structuredContent` (for code).
 */
export function toErrorResult(error: unknown): CallToolResult {
  const { code, message } =
    error instanceof ToolError
      ? error
      : { code: ErrorCode.Internal, message: "Internal error while running the tool." };

  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
  };
}
