import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Git } from "../../src/lib/git.js";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/fixture-repo.js";

let repo: FixtureRepo;
let git: Git;

beforeAll(async () => {
  repo = await createFixtureRepo();
  git = new Git(repo.root);
});

afterAll(async () => {
  await repo.cleanup();
});

describe("resolveCommit", () => {
  it("resolves branch names, HEAD and SHAs to full SHAs", async () => {
    await expect(git.resolveCommit("HEAD")).resolves.toBe(repo.headSha);
    await expect(git.resolveCommit("main")).resolves.toBe(repo.mainSha);
    await expect(git.resolveCommit(repo.baseSha.slice(0, 8))).resolves.toBe(repo.baseSha);
    await expect(git.resolveCommit("HEAD~1")).resolves.toBe(repo.baseSha);
  });

  it.each(["--output=/tmp/pwned", "-h", "main\0", "has space", "", "x".repeat(300)])(
    "rejects the malformed ref %j",
    async (ref) => {
      await expect(git.resolveCommit(ref)).rejects.toMatchObject({ code: "INVALID_REF" });
    },
  );

  it("rejects refs that don't exist", async () => {
    await expect(git.resolveCommit("no-such-branch")).rejects.toMatchObject({
      code: "INVALID_REF",
    });
  });

  it("rejects refs that aren't commits", async () => {
    await expect(git.resolveCommit("HEAD:README.md")).rejects.toMatchObject({
      code: "INVALID_REF",
    });
  });
});

describe("mergeBase", () => {
  it("finds the branch point", async () => {
    await expect(git.mergeBase(repo.mainSha, repo.headSha)).resolves.toBe(repo.baseSha);
  });
});

describe("run", () => {
  it("truncates output at maxBytes", async () => {
    const output = await git.run(["log", "--format=%H"], { maxBytes: 10 });

    expect(output.truncated).toBe(true);
    expect(output.stdout).toHaveLength(10);
  });

  it("treats pathspec magic as literal by default", async () => {
    const output = await git.run(["ls-files", "--", ":(top)README.md"], { maxBytes: 1024 });

    expect(output.stdout).toBe("");
  });

  it("reports failures as GIT_ERROR", async () => {
    await expect(
      git.run(["cat-file", "blob", "deadbeef"], { maxBytes: 1024 }),
    ).rejects.toMatchObject({ code: "GIT_ERROR" });
  });
});
