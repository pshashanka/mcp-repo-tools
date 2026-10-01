import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileTool } from "../../src/tools/read-file.js";
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

const read = (input: ToolInput<typeof readFileTool>) => callTool(readFileTool, input, context);

describe("read_file", () => {
  it("reads a whole file from the working tree", async () => {
    await expect(read({ path: "src/math.js" })).resolves.toEqual({
      path: "src/math.js",
      ref: null,
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      isBinary: false,
      content: "export const add = (a, b) => a + b;\nexport const multiply = (a, b) => a * b;\n",
      truncated: false,
    });
  });

  it("reads a line range", async () => {
    const output = await read({ path: "test/math.test.js", startLine: 5, endLine: 6 });

    expect(output).toMatchObject({ startLine: 5, endLine: 6, totalLines: 6, truncated: false });
    expect(output.content).toBe(
      'test("add", () => assert.equal(add(2, 3), 5));\n' +
        'test("multiply", () => assert.equal(multiply(2, 3), 6));\n',
    );
  });

  it("clamps endLine to the end of the file", async () => {
    await expect(read({ path: "src/math.js", startLine: 2, endLine: 99 })).resolves.toMatchObject({
      startLine: 2,
      endLine: 2,
    });
  });

  it("reads a file as it was at a given ref", async () => {
    const output = await read({ path: "src/math.js", ref: "main" });

    expect(output.ref).toBe(repo.mainSha);
    expect(output.content).toBe("export const add = (a, b) => a + b;\n");
  });

  it("reads a file that only exists at an older ref", async () => {
    await expect(read({ path: "src/legacy.js", ref: repo.baseSha })).resolves.toMatchObject({
      content: "export const old = true;\n",
    });
    await expect(read({ path: "src/legacy.js" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports a missing file at a ref as NOT_FOUND", async () => {
    await expect(read({ path: "src/strings.js", ref: repo.baseSha })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("detects binary files instead of returning garbage", async () => {
    await expect(read({ path: "assets/logo.png" })).resolves.toMatchObject({
      isBinary: true,
      content: "",
    });
  });

  it("truncates on whole lines and says where to continue", async () => {
    const small = await createContext(repo.root, { file: { limits: { maxFileBytes: 40 } } });
    const output = await callTool(readFileTool, { path: "test/math.test.js" }, small);

    expect(output).toMatchObject({ startLine: 1, endLine: 1, truncated: true });
    expect(output.content).toBe('import { test } from "node:test";\n');
    expect(readFileTool.render(output)).toContain("continue with startLine 2");
  });

  it("refuses denied paths in the working tree and at a ref", async () => {
    await expect(read({ path: ".env" })).rejects.toMatchObject({ code: "PATH_DENIED" });
    await expect(read({ path: ".env", ref: "HEAD" })).rejects.toMatchObject({
      code: "PATH_DENIED",
    });
    await expect(read({ path: ".git/config" })).rejects.toMatchObject({ code: "PATH_DENIED" });
  });

  it("refuses paths outside the repo", async () => {
    await expect(read({ path: "../../etc/passwd" })).rejects.toMatchObject({ code: "PATH_DENIED" });
  });

  it("rejects an invalid ref", async () => {
    await expect(read({ path: "src/math.js", ref: "--output=x" })).rejects.toMatchObject({
      code: "INVALID_REF",
    });
  });

  it("rejects a reversed range and a start past the end", async () => {
    await expect(read({ path: "src/math.js", startLine: 2, endLine: 1 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(read({ path: "src/math.js", startLine: 10 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("reads an empty file", async () => {
    await writeFile(join(repo.root, "empty.txt"), "");

    await expect(read({ path: "empty.txt" })).resolves.toMatchObject({
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      content: "",
    });
  });
});
