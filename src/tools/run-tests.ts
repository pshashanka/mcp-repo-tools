import { z } from "zod";
import type { Config } from "../config.js";
import { ErrorCode, ToolError } from "../lib/errors.js";
import { runProcess } from "../lib/exec.js";
import { defineTool } from "./tool.js";

/** Always passed to test processes; `envAllowlist` in the config adds more. */
const BASE_ENV = ["PATH", "HOME", "TMPDIR", "LANG"];

/**
 * Builds the run_tests tool for the configured targets, or returns null if
 * there are none. The target names become an enum in the input schema, so
 * clients can see exactly what is runnable and can't name anything else.
 */
export function createRunTestsTool(config: Config) {
  const [first, ...rest] = Object.keys(config.runTests.targets);
  if (first === undefined) return null;
  const targetNames = [first, ...rest] as const;

  return defineTool({
    name: "run_tests",
    title: "Run tests",
    description:
      "Run one of the server's pre-configured test commands in the repository and return its exit " +
      "code and output (the tail of each stream, if long). This executes the repository's own " +
      `code. Available targets: ${targetNames.join(", ")}.`,
    inputSchema: {
      target: z.enum(targetNames).describe("Which configured test command to run."),
      args: z
        .array(z.string())
        .max(20)
        .optional()
        .describe("Extra arguments, e.g. a test file. Only allowed if the target permits them."),
    },
    outputSchema: {
      target: z.string(),
      command: z.array(z.string()).describe("The exact argv that was run."),
      passed: z.boolean().describe("Exit code 0 and no timeout."),
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
      timedOut: z.boolean(),
      durationMs: z.number().int(),
      stdout: z.string(),
      stderr: z.string(),
      truncated: z.boolean().describe("True if output was cut; the end of each stream is kept."),
    },
    // Not read-only: it runs the repo's own code, which may do anything the user can.
    annotations: {
      title: "Run tests",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },

    async run(input, context) {
      const { runTests, repoRoot, limits } = context.config;
      // The tool is only registered when enabled; this guards direct use of `run`.
      if (!runTests.enabled) {
        throw new ToolError(ErrorCode.ToolDisabled, "run_tests is disabled on this server.");
      }
      const target = runTests.targets[input.target];
      if (target === undefined) {
        throw new ToolError(ErrorCode.InvalidInput, `Unknown test target: ${input.target}`);
      }

      const args = input.args ?? [];
      for (const arg of args) {
        if (!target.allowedArgs.some((pattern) => pattern.test(arg))) {
          throw new ToolError(
            ErrorCode.InvalidInput,
            `Argument ${JSON.stringify(arg)} is not allowed for target "${input.target}".`,
          );
        }
      }

      const [command = "", ...baseArgs] = target.command;
      const argv = [...baseArgs, ...args];
      const result = await runProcess({
        command,
        args: argv,
        cwd: repoRoot,
        env: testEnv(runTests.envAllowlist),
        timeoutMs: target.timeoutMs,
        maxOutputBytes: limits.maxOutputBytes,
        keep: "tail",
      }).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw new ToolError(ErrorCode.NotFound, `Test command not found: ${command}`);
        }
        throw error;
      });

      return {
        target: input.target,
        command: [command, ...argv],
        passed: result.exitCode === 0 && !result.timedOut,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
      };
    },

    render(output) {
      const outcome = output.timedOut
        ? "TIMED OUT"
        : output.passed
          ? "PASSED"
          : `FAILED (exit ${output.exitCode ?? output.signal ?? "?"})`;
      const sections = [
        `${output.target}: ${outcome} in ${output.durationMs} ms\n$ ${output.command.join(" ")}`,
      ];
      if (output.stdout !== "") sections.push(`--- stdout ---\n${output.stdout}`);
      if (output.stderr !== "") sections.push(`--- stderr ---\n${output.stderr}`);
      if (output.truncated) sections.push("[truncated: only the end of the output is shown]");
      return sections.join("\n\n");
    },
  });
}

/**
 * A minimal environment, so server secrets (tokens, cloud credentials) aren't
 * exposed to code from the repo. CI=true keeps test runners non-interactive.
 */
function testEnv(allowlist: readonly string[]): Record<string, string> {
  const env: Record<string, string> = { CI: "true", NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const name of [...BASE_ENV, ...allowlist]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
