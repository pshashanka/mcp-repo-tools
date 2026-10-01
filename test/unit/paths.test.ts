import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_DENY_GLOBS } from "../../src/config.js";
import { RepoPaths } from "../../src/lib/paths.js";

let sandbox: string;
let repoRoot: string;
let paths: RepoPaths;

beforeAll(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "repo-paths-")));
  repoRoot = join(sandbox, "repo");
  await mkdir(join(repoRoot, "src"), { recursive: true });
  await mkdir(join(repoRoot, ".git"));
  await writeFile(join(repoRoot, "src", "index.ts"), "export {};\n");
  await writeFile(join(repoRoot, ".env"), "SECRET=1\n");
  await writeFile(join(repoRoot, ".git", "config"), "[core]\n");
  await writeFile(join(sandbox, "outside.txt"), "outside\n");
  await symlink(join(repoRoot, "src", "index.ts"), join(repoRoot, "link-inside.ts"));
  await symlink(join(sandbox, "outside.txt"), join(repoRoot, "link-outside.txt"));
  await symlink(join(repoRoot, ".env"), join(repoRoot, "innocent.txt"));

  paths = new RepoPaths({ repoRoot, allowGlobs: ["**"], denyGlobs: DEFAULT_DENY_GLOBS });
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("normalize", () => {
  it.each([
    ["src/index.ts", "src/index.ts"],
    ["./src/index.ts", "src/index.ts"],
    ["src//lib/../index.ts", "src/index.ts"],
    ["src/", "src"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(paths.normalize(input)).toBe(expected);
  });

  it.each(["../outside.txt", "src/../../outside.txt", "..", "/etc/passwd", ".", "", "a\0b"])(
    "rejects %j",
    (input) => {
      expect(() => paths.normalize(input)).toThrow(
        expect.objectContaining({ code: "PATH_DENIED" }),
      );
    },
  );
});

describe("isAllowed", () => {
  it.each([".git/config", ".git", ".env", "pkg/.env.local", "certs/server.pem", "home/.npmrc"])(
    "denies %j by default",
    (path) => {
      expect(paths.isAllowed(path)).toBe(false);
    },
  );

  it("denies regardless of case", () => {
    expect(paths.isAllowed(".ENV")).toBe(false);
  });

  it("allows ordinary source files", () => {
    expect(paths.isAllowed("src/index.ts")).toBe(true);
    expect(paths.isAllowed(".github/workflows/ci.yml")).toBe(true);
  });

  it("only allows paths matching allowGlobs when they are narrowed", () => {
    const narrow = new RepoPaths({ repoRoot, allowGlobs: ["src/**"], denyGlobs: [] });
    expect(narrow.isAllowed("src/index.ts")).toBe(true);
    expect(narrow.isAllowed("README.md")).toBe(false);
  });
});

describe("resolveFile", () => {
  it("resolves a file inside the repo", async () => {
    await expect(paths.resolveFile("src/index.ts")).resolves.toMatchObject({
      path: "src/index.ts",
      size: 11,
    });
  });

  it("follows a symlink that stays inside the repo", async () => {
    await expect(paths.resolveFile("link-inside.ts")).resolves.toMatchObject({
      path: "src/index.ts",
    });
  });

  it("rejects a symlink that escapes the repo", async () => {
    await expect(paths.resolveFile("link-outside.txt")).rejects.toMatchObject({
      code: "PATH_DENIED",
    });
  });

  it("rejects a symlink whose target is denied", async () => {
    await expect(paths.resolveFile("innocent.txt")).rejects.toMatchObject({ code: "PATH_DENIED" });
  });

  it("rejects denied paths before touching the filesystem", async () => {
    await expect(paths.resolveFile(".git/config")).rejects.toMatchObject({ code: "PATH_DENIED" });
  });

  it("reports missing files as NOT_FOUND", async () => {
    await expect(paths.resolveFile("src/missing.ts")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports directories as NOT_FOUND", async () => {
    await expect(paths.resolveFile("src")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
