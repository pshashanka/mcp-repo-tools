import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listChangedFilesTool } from "../../src/tools/list-changed-files.js";
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

const list = (input: ToolInput<typeof listChangedFilesTool>) =>
  callTool(listChangedFilesTool, input, context);

describe("list_changed_files", () => {
  it("lists the changes on head since it branched from base", async () => {
    const output = await list({ base: "main" });

    expect(output.base).toBe(repo.mainSha);
    expect(output.head).toBe(repo.headSha);
    expect(output.mergeBase).toBe(repo.baseSha);
    expect(output.files).toEqual([
      {
        path: ".env",
        oldPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        isBinary: false,
        isTest: false,
      },
      {
        path: "assets/logo.png",
        oldPath: null,
        status: "added",
        additions: 0,
        deletions: 0,
        isBinary: true,
        isTest: false,
      },
      {
        path: "docs/new-name.md",
        oldPath: "docs/old-name.md",
        status: "renamed",
        additions: 0,
        deletions: 0,
        isBinary: false,
        isTest: false,
      },
      {
        path: "src/legacy.js",
        oldPath: null,
        status: "deleted",
        additions: 0,
        deletions: 1,
        isBinary: false,
        isTest: false,
      },
      {
        path: "src/math.js",
        oldPath: null,
        status: "modified",
        additions: 1,
        deletions: 0,
        isBinary: false,
        isTest: false,
      },
      {
        path: "src/strings.js",
        oldPath: null,
        status: "added",
        additions: 2,
        deletions: 0,
        isBinary: false,
        isTest: false,
      },
      {
        path: "test/math.test.js",
        oldPath: null,
        status: "modified",
        additions: 2,
        deletions: 1,
        isBinary: false,
        isTest: true,
      },
    ]);
  });

  it("includes base-only changes in direct mode", async () => {
    const output = await list({ base: "main", mode: "direct" });

    expect(output.mergeBase).toBeNull();
    expect(output.files.map((f) => f.path)).toContain("README.md");
  });

  it("filters by literal paths", async () => {
    const output = await list({ base: "main", paths: ["src", "./test/math.test.js"] });

    expect(output.files.map((f) => f.path)).toEqual([
      "src/legacy.js",
      "src/math.js",
      "src/strings.js",
      "test/math.test.js",
    ]);
  });

  it("uses the configured test globs", async () => {
    const custom = await createContext(repo.root, { file: { testGlobs: ["src/strings.js"] } });
    const output = await callTool(listChangedFilesTool, { base: "main" }, custom);

    expect(output.files.filter((f) => f.isTest).map((f) => f.path)).toEqual(["src/strings.js"]);
  });

  it("returns an empty list when nothing changed", async () => {
    await expect(list({ base: "HEAD", head: "HEAD" })).resolves.toMatchObject({ files: [] });
  });

  it("rejects invalid refs and paths", async () => {
    await expect(list({ base: "nope" })).rejects.toMatchObject({ code: "INVALID_REF" });
    await expect(list({ base: "-p" })).rejects.toMatchObject({ code: "INVALID_REF" });
    await expect(list({ base: "main", paths: ["../x"] })).rejects.toMatchObject({
      code: "PATH_DENIED",
    });
  });

  it("renders a compact summary", async () => {
    const text = listChangedFilesTool.render(await list({ base: "main" }));

    expect(text).toContain("7 files changed (since merge-base)");
    expect(text).toContain("renamed      +0 -0        docs/old-name.md -> docs/new-name.md");
    expect(text).toContain("test/math.test.js  [test]");
  });
});
