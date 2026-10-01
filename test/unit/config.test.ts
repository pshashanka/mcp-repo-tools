import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_DENY_GLOBS, createConfig } from "../../src/config.js";

let dir: string;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "config-")));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createConfig", () => {
  it("uses safe defaults", async () => {
    const config = await createConfig({ repo: dir });

    expect(config.repoRoot).toBe(dir);
    expect(config.allowGlobs).toEqual(["**"]);
    expect(config.denyGlobs).toEqual(DEFAULT_DENY_GLOBS);
    expect(config.runTests.enabled).toBe(false);
    expect(config.runTests.targets).toEqual({});
  });

  it("adds to the default deny globs instead of replacing them", async () => {
    const config = await createConfig({ repo: dir, file: { denyGlobs: ["secrets/**"] } });

    expect(config.denyGlobs).toEqual([...DEFAULT_DENY_GLOBS, "secrets/**"]);
  });

  it("anchors allowedArgs patterns so they must match the whole argument", async () => {
    const config = await createConfig({
      repo: dir,
      file: {
        runTests: { targets: { unit: { command: ["npm", "test"], allowedArgs: ["[\\w/.-]+"] } } },
      },
    });
    const [pattern] = config.runTests.targets["unit"]?.allowedArgs ?? [];

    expect(pattern?.test("src/foo.test.ts")).toBe(true);
    expect(pattern?.test("src/foo.test.ts; rm -rf /")).toBe(false);
  });

  it("rejects unknown config keys", async () => {
    await expect(
      createConfig({ repo: dir, file: { denyGlob: [] } as unknown as Record<string, never> }),
    ).rejects.toThrow();
  });

  it("rejects a repo path that does not exist", async () => {
    await expect(createConfig({ repo: join(dir, "nope") })).rejects.toThrow(/does not exist/);
  });
});
