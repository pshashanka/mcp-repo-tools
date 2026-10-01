import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { Git } from "./lib/git.js";

/** Paths that are never readable, even if an allow glob matches them. */
export const DEFAULT_DENY_GLOBS = [
  "**/.git",
  "**/.git/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/id_rsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/.npmrc",
  "**/.netrc",
  "**/.pypirc",
  "**/.envrc",
  "**/.git-credentials",
  "**/.aws/**",
];

export const DEFAULT_TEST_GLOBS = [
  "**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
  "**/*_test.{go,py}",
  "**/test_*.py",
];

const TestTargetSchema = z.object({
  /** argv to execute, never passed through a shell. `command[0]` is resolved on PATH. */
  command: z.array(z.string().min(1)).min(1),
  /**
   * Regexes; every caller-supplied extra arg must fully match one of them.
   * Empty (the default) means the target takes no extra args.
   */
  allowedArgs: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().optional(),
});

/** The operator-supplied config file (`--config`). Every field is optional. */
export const ConfigFileSchema = z
  .object({
    allowGlobs: z.array(z.string()).min(1),
    denyGlobs: z.array(z.string()),
    testGlobs: z.array(z.string()),
    limits: z
      .object({
        maxFileBytes: z.number().int().positive(),
        maxDiffBytes: z.number().int().positive(),
        maxSearchResults: z.number().int().positive(),
        maxOutputBytes: z.number().int().positive(),
      })
      .partial(),
    runTests: z
      .object({
        timeoutMs: z.number().int().positive(),
        /** Extra env vars passed through to test processes (PATH and HOME always are). */
        envAllowlist: z.array(z.string()),
        targets: z.record(z.string().regex(/^[\w.-]+$/), TestTargetSchema),
      })
      .partial(),
  })
  .partial()
  .strict();

export type ConfigFile = z.input<typeof ConfigFileSchema>;

export interface TestTarget {
  command: string[];
  allowedArgs: RegExp[];
  timeoutMs: number;
}

export interface Config {
  /** Canonical absolute path of the repository root. */
  repoRoot: string;
  allowGlobs: string[];
  /** Always includes DEFAULT_DENY_GLOBS; a config file can add to them, not remove them. */
  denyGlobs: string[];
  testGlobs: string[];
  limits: {
    maxFileBytes: number;
    maxDiffBytes: number;
    maxSearchResults: number;
    maxOutputBytes: number;
  };
  runTests: {
    enabled: boolean;
    envAllowlist: string[];
    targets: Record<string, TestTarget>;
  };
}

export interface ConfigOptions {
  repo: string;
  allowRunTests?: boolean;
  file?: ConfigFile;
}

/** Builds a validated Config from CLI options and an optional parsed config file. */
export async function createConfig(options: ConfigOptions): Promise<Config> {
  const repoRoot = await realpath(resolve(options.repo)).catch(() => {
    throw new Error(`Repository path does not exist: ${options.repo}`);
  });
  if (!(await stat(repoRoot)).isDirectory()) {
    throw new Error(`Repository path is not a directory: ${options.repo}`);
  }

  // Git reports paths relative to the top level, and the path policy works
  // relative to repoRoot, so the two must be the same directory.
  const topLevel = await new Git(repoRoot)
    .run(["rev-parse", "--show-toplevel"], { maxBytes: 4096 })
    .then((output) => output.stdout.trim())
    .catch(() => null);
  if (topLevel === null) throw new Error(`Not a git repository: ${options.repo}`);
  if ((await realpath(topLevel)) !== repoRoot) {
    throw new Error(`--repo must be the root of the git work tree: ${topLevel}`);
  }

  const file = ConfigFileSchema.parse(options.file ?? {});
  const defaultTimeoutMs = file.runTests?.timeoutMs ?? 120_000;

  const targets: Record<string, TestTarget> = {};
  for (const [name, target] of Object.entries(file.runTests?.targets ?? {})) {
    targets[name] = {
      command: target.command,
      allowedArgs: target.allowedArgs.map((pattern) => new RegExp(`^(?:${pattern})$`)),
      timeoutMs: target.timeoutMs ?? defaultTimeoutMs,
    };
  }

  return {
    repoRoot,
    allowGlobs: file.allowGlobs ?? ["**"],
    denyGlobs: [...DEFAULT_DENY_GLOBS, ...(file.denyGlobs ?? [])],
    testGlobs: file.testGlobs ?? DEFAULT_TEST_GLOBS,
    limits: {
      maxFileBytes: file.limits?.maxFileBytes ?? 256 * 1024,
      maxDiffBytes: file.limits?.maxDiffBytes ?? 512 * 1024,
      maxSearchResults: file.limits?.maxSearchResults ?? 500,
      maxOutputBytes: file.limits?.maxOutputBytes ?? 64 * 1024,
    },
    runTests: {
      enabled: options.allowRunTests ?? false,
      envAllowlist: file.runTests?.envAllowlist ?? [],
      targets,
    },
  };
}

/** Reads and validates a JSON config file. */
export async function loadConfigFile(path: string): Promise<ConfigFile> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  return ConfigFileSchema.parse(raw);
}
