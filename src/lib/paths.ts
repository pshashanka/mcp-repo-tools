import { realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, sep } from "node:path";
import picomatch from "picomatch";
import { ErrorCode, ToolError } from "./errors.js";

export interface RepoPathPolicy {
  repoRoot: string;
  allowGlobs: string[];
  denyGlobs: string[];
}

export interface ResolvedFile {
  /** Repo-relative POSIX path of the real file (after following symlinks). */
  path: string;
  absolutePath: string;
  size: number;
}

/**
 * The single place that decides whether a path may be read.
 *
 * Every path from a client goes through `normalize` (lexical checks) and then
 * either `resolveFile` (working tree: follows symlinks and checks again) or
 * `assertAllowed` (git objects, which have no symlinks to follow).
 */
export class RepoPaths {
  readonly #root: string;
  readonly #isAllowed: (path: string) => boolean;
  readonly #isDenied: (path: string) => boolean;

  constructor(policy: RepoPathPolicy) {
    this.#root = policy.repoRoot;
    this.#isAllowed = picomatch(policy.allowGlobs, { dot: true });
    // nocase: on case-insensitive filesystems ".ENV" opens ".env".
    this.#isDenied = picomatch(policy.denyGlobs, { dot: true, nocase: true });
  }

  /** Validates a client-supplied path and returns it as a clean repo-relative POSIX path. */
  normalize(input: string): string {
    if (input.includes("\0")) throw denied(input, "contains a NUL byte");
    if (isAbsolute(input) || posix.isAbsolute(input)) throw denied(input, "must be repo-relative");

    const normalized = posix.normalize(input);
    if (normalized === ".." || normalized.startsWith("../")) {
      throw denied(input, "escapes the repository");
    }
    if (normalized === "." || normalized === "") throw denied(input, "is the repository root");
    return normalized.replace(/\/+$/, "");
  }

  isAllowed(path: string): boolean {
    return this.#isAllowed(path) && !this.#isDenied(path);
  }

  /** Throws PATH_DENIED unless the (already normalized) path passes the allow/deny globs. */
  assertAllowed(path: string): void {
    if (!this.isAllowed(path)) throw denied(path, "is not allowed by the server's path policy");
  }

  /**
   * Resolves a path in the working tree to a regular file inside the repo.
   * Symlinks are followed and the target is checked too, so a link can't be
   * used to reach a file outside the repo or one that is denied.
   */
  async resolveFile(input: string): Promise<ResolvedFile> {
    const path = this.normalize(input);
    this.assertAllowed(path);

    const real = await realpath(`${this.#root}${sep}${path}`).catch((error: unknown) => {
      if (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        throw new ToolError(ErrorCode.NotFound, `No such file: ${path}`);
      }
      throw error;
    });

    const realRelative = relative(this.#root, real);
    if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
      throw denied(path, "resolves outside the repository");
    }
    const realPath = realRelative.split(sep).join("/");
    this.assertAllowed(realPath);

    const info = await stat(real);
    if (!info.isFile()) throw new ToolError(ErrorCode.NotFound, `Not a regular file: ${path}`);
    return { path: realPath, absolutePath: real, size: info.size };
  }
}

function denied(path: string, reason: string): ToolError {
  return new ToolError(ErrorCode.PathDenied, `Path "${path}" ${reason}.`);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
