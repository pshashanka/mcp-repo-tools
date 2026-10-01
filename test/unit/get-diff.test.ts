import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDiffTool } from "../../src/tools/get-diff.js";
import type { ToolContext } from "../../src/tools/tool.js";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/fixture-repo.js";
import { callTool, createContext, type ToolInput } from "../helpers.js";

let repo: FixtureRepo;
let context: ToolContext;

beforeAll(async () => {
  repo = await createFixtureRepo();
  context = await createContext(repo.root);
});

afterAll(async () => {
  await repo.cleanup();
});

const diff = (input: ToolInput<typeof getDiffTool>) => callTool(getDiffTool, input, context);
const byPath = (output: Awaited<ReturnType<typeof diff>>, path: string) =>
  output.files.find((f) => f.path === path);

describe("get_diff", () => {
  it("returns one unified patch per file", async () => {
    const output = await diff({ base: "main" });

    expect(output.mergeBase).toBe(repo.baseSha);
    expect(output.truncated).toBe(false);
    const math = byPath(output, "src/math.js");
    expect(math).toMatchObject({ status: "modified", patchOmitted: null });
    expect(math?.patch).toMatch(/^diff --git a\/src\/math.js b\/src\/math.js\n/);
    expect(math?.patch).toContain("+export const multiply = (a, b) => a * b;");
  });

  it("does not include base-only changes in merge-base mode", async () => {
    const output = await diff({ base: "main" });

    expect(byPath(output, "README.md")).toBeUndefined();
  });

  it("includes base-only changes in direct mode", async () => {
    const output = await diff({ base: "main", mode: "direct" });

    expect(byPath(output, "README.md")?.patch).toContain(
      "-A tiny project used in tests. Updated on main.",
    );
  });

  it("detects renames", async () => {
    const output = await diff({ base: "main" });

    const renamed = byPath(output, "docs/new-name.md");
    expect(renamed).toMatchObject({ oldPath: "docs/old-name.md", status: "renamed" });
    expect(renamed?.patch).toContain("rename from docs/old-name.md");
  });

  it("omits patches for binary and denied files but still lists them", async () => {
    const output = await diff({ base: "main" });

    expect(byPath(output, "assets/logo.png")).toMatchObject({ patch: "", patchOmitted: "binary" });
    expect(byPath(output, ".env")).toMatchObject({ patch: "", patchOmitted: "denied" });
    expect(JSON.stringify(output)).not.toContain("secret");
  });

  it("honours contextLines", async () => {
    const output = await diff({ base: "main", paths: ["test/math.test.js"], contextLines: 0 });

    expect(byPath(output, "test/math.test.js")?.patch).not.toContain(
      ' import { test } from "node:test";',
    );
  });

  it("omits patches that don't fit the budget and says so", async () => {
    const output = await diff({ base: "main", maxBytes: 400 });
    const included = output.files.filter((f) => f.patchOmitted === null);
    const omitted = output.files.filter((f) => f.patchOmitted === "size_limit");

    expect(output.truncated).toBe(true);
    expect(omitted.length).toBeGreaterThan(0);
    expect(included.reduce((sum, f) => sum + Buffer.byteLength(f.patch), 0)).toBeLessThanOrEqual(
      400,
    );
    expect(getDiffTool.render(output)).toContain("patch omitted (size_limit)");
  });

  it("never exceeds the server's diff limit", async () => {
    const strict = await createContext(repo.root, { file: { limits: { maxDiffBytes: 100 } } });
    const output = await callTool(getDiffTool, { base: "main", maxBytes: 10_000_000 }, strict);

    expect(output.files.every((f) => Buffer.byteLength(f.patch) <= 100)).toBe(true);
  });

  it("rejects invalid refs", async () => {
    await expect(diff({ base: "main", head: "--output=/tmp/x" })).rejects.toMatchObject({
      code: "INVALID_REF",
    });
  });
});
