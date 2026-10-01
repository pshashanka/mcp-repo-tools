import { describe, expect, it } from "vitest";
import { ErrorCode, ToolError, toErrorResult } from "../../src/lib/errors.js";

describe("toErrorResult", () => {
  it("reports a ToolError's code and message", () => {
    const result = toErrorResult(new ToolError(ErrorCode.NotFound, "No such file: a.ts"));

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "NOT_FOUND: No such file: a.ts" }],
    });
  });

  it("hides the details of unexpected errors", () => {
    const result = toErrorResult(new Error("ENOENT /Users/someone/secret/path"));

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("/Users/someone");
    expect(result.content).toEqual([
      { type: "text", text: "INTERNAL: Internal error while running the tool." },
    ]);
  });
});
