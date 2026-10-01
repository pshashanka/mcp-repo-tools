import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConfigFile } from "../../src/config.js";
import { createRunTestsTool } from "../../src/tools/run-tests.js";
import type { ToolContext } from "../../src/tools/tool.js";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/fixture-repo.js";
import { callTool, createContext } from "../helpers.js";

const node = process.execPath;

const configFile: ConfigFile = {
  runTests: {
    envAllowlist: ["MCP_REPO_TOOLS_ALLOWED"],
    targets: {
      unit: { command: [node, "--test"], allowedArgs: ["test/[\\w./-]+\\.test\\.js"] },
      fail: { command: [node, "-e", "console.error('boom'); process.exit(2)"] },
      slow: { command: [node, "-e", "setInterval(() => {}, 1000)"], timeoutMs: 300 },
      env: { command: [node, "-e", "console.log(JSON.stringify(process.env))"] },
      missing: { command: ["definitely-not-a-real-command"] },
    },
  },
};

let repo: FixtureRepo;
let context: ToolContext;
let tool: NonNullable<ReturnType<typeof createRunTestsTool>>;

beforeAll(async () => {
  repo = await createFixtureRepo();
  context = await createContext(repo.root, { file: configFile, allowRunTests: true });
  const created = createRunTestsTool(context.config);
  if (created === null) throw new Error("expected run_tests to be created");
  tool = created;
});

afterAll(async () => {
  await repo.cleanup();
});

type Input = Parameters<typeof tool.run>[0];
const run = (input: Input) => callTool(tool, input, context);

describe("run_tests", () => {
  it("is not created when no targets are configured", async () => {
    const bare = await createContext(repo.root, { allowRunTests: true });

    expect(createRunTestsTool(bare.config)).toBeNull();
  });

  it("refuses to run when the server didn't enable it", async () => {
    const disabled = await createContext(repo.root, { file: configFile });

    await expect(callTool(tool, { target: "unit" }, disabled)).rejects.toMatchObject({
      code: "TOOL_DISABLED",
    });
  });

  it("lists the targets in its description and schema", () => {
    expect(tool.description).toContain("unit, fail, slow, env, missing");
    expect(tool.inputSchema.target.options).toEqual(["unit", "fail", "slow", "env", "missing"]);
  });

  it("runs a passing test suite", async () => {
    const output = await run({ target: "unit" });

    expect(output).toMatchObject({ passed: true, exitCode: 0, timedOut: false, truncated: false });
    expect(output.stdout).toMatch(/pass 2/);
    expect(output.command).toEqual([node, "--test"]);
  });

  it("passes allowed extra arguments", async () => {
    const output = await run({ target: "unit", args: ["test/math.test.js"] });

    expect(output.command).toEqual([node, "--test", "test/math.test.js"]);
    expect(output.passed).toBe(true);
  });

  it.each([
    ["an option", "--test-reporter=spec"],
    ["shell syntax", "test/math.test.js; rm -rf ~"],
    ["a path outside the test dir", "../evil.test.js"],
  ])("rejects %s as an argument", async (_label, arg) => {
    await expect(run({ target: "unit", args: [arg] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rejects any argument for a target that doesn't allow them", async () => {
    await expect(run({ target: "fail", args: ["x"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rejects unknown targets at the schema level", async () => {
    await expect(run({ target: "rm" })).rejects.toThrow(/Invalid option/);
  });

  it("reports a failing run as a result, not an error", async () => {
    const output = await run({ target: "fail" });

    expect(output).toMatchObject({ passed: false, exitCode: 2, stderr: "boom\n" });
    expect(tool.render(output)).toContain("fail: FAILED (exit 2)");
  });

  it("kills a run that exceeds its timeout", async () => {
    const output = await run({ target: "slow" });

    expect(output).toMatchObject({ passed: false, timedOut: true, signal: "SIGKILL" });
    expect(tool.render(output)).toContain("TIMED OUT");
  });

  it("passes only allowlisted environment variables", async () => {
    process.env["MCP_REPO_TOOLS_ALLOWED"] = "yes";
    process.env["MCP_REPO_TOOLS_SECRET"] = "no";
    try {
      const env = JSON.parse((await run({ target: "env" })).stdout) as Record<string, string>;

      expect(env["MCP_REPO_TOOLS_ALLOWED"]).toBe("yes");
      expect(env["MCP_REPO_TOOLS_SECRET"]).toBeUndefined();
      expect(env["CI"]).toBe("true");
    } finally {
      delete process.env["MCP_REPO_TOOLS_ALLOWED"];
      delete process.env["MCP_REPO_TOOLS_SECRET"];
    }
  });

  it("reports a missing command as NOT_FOUND", async () => {
    await expect(run({ target: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
