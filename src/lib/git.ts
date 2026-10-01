import { ErrorCode, ToolError } from "./errors.js";
import { runProcess } from "./exec.js";

const GIT_TIMEOUT_MS = 30_000;

/**
 * Config overrides applied to every invocation. The served repo may be an
 * untrusted checkout, and its .git/config can name programs for git to run
 * (fsmonitor, external diff, textconv), so those are switched off.
 */
const HARDENING_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.quotePath=false",
  "-c",
  "diff.external=",
];

/** A minimal environment: no user/system config, no prompts, no network, no lock-taking. */
function gitEnv(): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
  };
}

export interface GitRunOptions {
  maxBytes: number;
  /** Exit codes that count as success. `git grep` exits 1 for "no matches". */
  okExitCodes?: readonly number[];
  /** How git interprets pathspecs after `--`. Defaults to literal, so ":(magic)" is inert. */
  pathspecs?: "literal" | "glob";
}

export interface GitOutput {
  stdout: string;
  exitCode: number;
  truncated: boolean;
}

// Rejects option injection ("-...") and control characters. Everything else is
// left for `git rev-parse` to accept or reject.
const REF_PATTERN = /^(?!-)[^\0-\x20\x7f]{1,256}$/;

export class Git {
  constructor(private readonly repoRoot: string) {}

  async run(args: readonly string[], options: GitRunOptions): Promise<GitOutput> {
    const pathspecFlag = options.pathspecs === "glob" ? "--glob-pathspecs" : "--literal-pathspecs";
    const result = await runProcess({
      command: "git",
      args: [...HARDENING_ARGS, pathspecFlag, ...args],
      cwd: this.repoRoot,
      env: gitEnv(),
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: options.maxBytes,
      keep: "head",
    });

    if (result.timedOut) {
      throw new ToolError(ErrorCode.Timeout, `git ${args[0] ?? ""} timed out.`);
    }
    // When we stop reading because output hit the cap, git dies of SIGKILL; that's success.
    if (result.truncated && result.signal === "SIGKILL") {
      return { stdout: result.stdout, exitCode: 0, truncated: true };
    }
    const okExitCodes = options.okExitCodes ?? [0];
    if (result.exitCode === null || !okExitCodes.includes(result.exitCode)) {
      const detail = result.stderr.trim().split("\n")[0] ?? "";
      throw new ToolError(ErrorCode.GitError, `git ${args[0] ?? ""} failed: ${detail}`);
    }
    return { stdout: result.stdout, exitCode: result.exitCode, truncated: result.truncated };
  }

  /**
   * Resolves a client-supplied ref to a full commit SHA. Tools pass only
   * resolved SHAs to later git commands, so refs are validated exactly once.
   */
  async resolveCommit(ref: string): Promise<string> {
    if (!REF_PATTERN.test(ref)) {
      throw new ToolError(ErrorCode.InvalidRef, `Invalid ref: ${JSON.stringify(ref)}`);
    }
    const { stdout, exitCode } = await this.run(
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
      { maxBytes: 1024, okExitCodes: [0, 1, 128] },
    );
    const sha = stdout.trim();
    if (exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
      throw new ToolError(ErrorCode.InvalidRef, `Unknown commit: ${JSON.stringify(ref)}`);
    }
    return sha;
  }

  /** Returns the best common ancestor, or null if the histories are unrelated. */
  async mergeBase(a: string, b: string): Promise<string | null> {
    const { stdout, exitCode } = await this.run(["merge-base", a, b], {
      maxBytes: 1024,
      okExitCodes: [0, 1],
    });
    return exitCode === 0 ? stdout.trim() : null;
  }
}
