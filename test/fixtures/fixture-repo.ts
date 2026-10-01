import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface FixtureRepo {
  root: string;
  /** Where `feature` branched from `main`. */
  baseSha: string;
  /** Tip of `main`, one commit past `baseSha` (it changes README.md). */
  mainSha: string;
  /** Tip of `feature`, which is checked out. */
  headSha: string;
  cleanup: () => Promise<void>;
}

/**
 * Builds a small repo shaped like a pull request under review:
 *
 *   main:    base ── main-only (README.md edited)
 *              \
 *   feature:    feature (modify, add, delete, rename, binary)   ← HEAD
 *
 * It's built at test time, not committed, so this repo never contains a nested .git.
 */
export async function createFixtureRepo(): Promise<FixtureRepo> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mcp-repo-tools-fixture-")));
  let tick = 0;
  const git = (...args: string[]): string => {
    tick += 1;
    const date = `2026-01-01T00:00:${String(tick).padStart(2, "0")}Z`;
    return execFileSync("git", ["-c", "init.defaultBranch=main", ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    }).trim();
  };
  const write = async (path: string, content: string | Uint8Array) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };

  git("init", "--quiet");

  await write(
    "package.json",
    JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }, null, 2),
  );
  await write("README.md", "# Fixture\n\nA tiny project used in tests.\n");
  await write(".env", "API_KEY=do-not-leak\n");
  await write("src/math.js", "export const add = (a, b) => a + b;\n");
  await write("src/legacy.js", "export const old = true;\n");
  await write("docs/old-name.md", "# Guide\n\nThis document gets renamed.\n");
  await write(
    "test/math.test.js",
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { add } from "../src/math.js";',
      "",
      'test("add", () => assert.equal(add(2, 3), 5));',
      "",
    ].join("\n"),
  );
  git("add", "--all");
  git("commit", "--quiet", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");

  await write("README.md", "# Fixture\n\nA tiny project used in tests. Updated on main.\n");
  git("commit", "--quiet", "-am", "main-only change");
  const mainSha = git("rev-parse", "HEAD");

  git("checkout", "--quiet", "-b", "feature", baseSha);
  await write(
    "src/math.js",
    "export const add = (a, b) => a + b;\nexport const multiply = (a, b) => a * b;\n",
  );
  await write(
    "src/strings.js",
    "// TODO: handle unicode\nexport const shout = (s) => s.toUpperCase();\n",
  );
  await write(
    "test/math.test.js",
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { add, multiply } from "../src/math.js";',
      "",
      'test("add", () => assert.equal(add(2, 3), 5));',
      'test("multiply", () => assert.equal(multiply(2, 3), 6));',
      "",
    ].join("\n"),
  );
  await write("assets/logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
  git("rm", "--quiet", "src/legacy.js");
  git("mv", "docs/old-name.md", "docs/new-name.md");
  git("add", "--all");
  git("commit", "--quiet", "-m", "feature work");
  const headSha = git("rev-parse", "HEAD");

  return {
    root,
    baseSha,
    mainSha,
    headSha,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
