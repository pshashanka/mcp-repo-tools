import { describe, expect, it } from "vitest";
import { runProcess, type RunOptions } from "../../src/lib/exec.js";

const node = (script: string, overrides: Partial<RunOptions> = {}) =>
  runProcess({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: { PATH: process.env["PATH"] ?? "" },
    timeoutMs: 5_000,
    maxOutputBytes: 1024,
    keep: "tail",
    ...overrides,
  });

describe("runProcess", () => {
  it("captures exit code and output", async () => {
    const result = await node(
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
    );

    expect(result).toMatchObject({
      exitCode: 3,
      signal: null,
      stdout: "out",
      stderr: "err",
      truncated: false,
      timedOut: false,
    });
  });

  it("passes only the given environment", async () => {
    process.env["MCP_REPO_TOOLS_TEST_SECRET"] = "leaked";
    try {
      const result = await node(
        "process.stdout.write(String(process.env.MCP_REPO_TOOLS_TEST_SECRET))",
      );
      expect(result.stdout).toBe("undefined");
    } finally {
      delete process.env["MCP_REPO_TOOLS_TEST_SECRET"];
    }
  });

  it("does not interpret arguments through a shell", async () => {
    const result = await runProcess({
      command: "echo",
      args: ["$HOME", "; whoami"],
      cwd: process.cwd(),
      env: { PATH: process.env["PATH"] ?? "" },
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
      keep: "head",
    });

    expect(result.stdout).toBe("$HOME ; whoami\n");
  });

  it("kills the whole process group on timeout", async () => {
    // The grandchild inherits our pipes, so "close" only fires (and the test only
    // finishes) if the grandchild is killed along with the child.
    const result = await node(
      "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000)",
      { timeoutMs: 300 },
    );

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  });

  it("keeps the tail of long output", async () => {
    const result = await node("for (let i = 0; i < 1000; i++) console.log('line ' + i)", {
      maxOutputBytes: 20,
    });

    expect(result.truncated).toBe(true);
    expect(result.stdout.endsWith("line 999\n")).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(20);
  });

  it("keeps the head of long output and stops the process early", async () => {
    const result = await node("setInterval(() => process.stdout.write('x'.repeat(1000)), 1)", {
      keep: "head",
      maxOutputBytes: 100,
    });

    expect(result.truncated).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("x".repeat(100));
  });

  it("rejects when the command does not exist", async () => {
    await expect(
      runProcess({
        command: "definitely-not-a-real-command",
        args: [],
        cwd: process.cwd(),
        env: { PATH: process.env["PATH"] ?? "" },
        timeoutMs: 1_000,
        maxOutputBytes: 1024,
        keep: "tail",
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
