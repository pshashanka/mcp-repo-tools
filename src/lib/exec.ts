import { spawn } from "node:child_process";
import { keepHead, keepTail } from "./truncate.js";

export interface RunOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  /** The complete environment for the child. Nothing is inherited implicitly. */
  env: Record<string, string>;
  timeoutMs: number;
  /** Per-stream cap on captured output. */
  maxOutputBytes: number;
  /**
   * "head" keeps the start of each stream and kills the process once stdout
   * passes the cap (right for git). "tail" keeps the end and lets the process
   * finish (right for test runners, whose summaries come last).
   */
  keep: "head" | "tail";
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Runs a command without a shell, with a hard timeout and bounded output.
 * The child gets its own process group so a timeout kills everything it
 * spawned, not just the direct child.
 *
 * Rejects only if the process can't be started (e.g. command not found).
 */
export function runProcess(options: RunOptions): Promise<RunResult> {
  const started = performance.now();

  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
    });

    // Capture a few bytes past the cap so truncation can land on a character boundary.
    const window = options.maxOutputBytes + 4;
    const stdout = new BoundedBuffer(window, options.keep);
    const stderr = new BoundedBuffer(window, options.keep);
    let timedOut = false;
    let killed = false;

    const killTree = () => {
      if (killed || child.pid === undefined) return;
      killed = true;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      if (options.keep === "head" && stdout.totalBytes > options.maxOutputBytes) killTree();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      const out = stdout.toText(options.maxOutputBytes);
      const err = stderr.toText(options.maxOutputBytes);
      resolve({
        exitCode,
        signal,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        timedOut,
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}

/** Keeps either the first or the last `limit` bytes written to it. */
class BoundedBuffer {
  #chunks: Buffer[] = [];
  #storedBytes = 0;
  totalBytes = 0;

  constructor(
    private readonly limit: number,
    private readonly keep: "head" | "tail",
  ) {}

  push(chunk: Buffer): void {
    this.totalBytes += chunk.length;

    if (this.keep === "head") {
      const room = this.limit - this.#storedBytes;
      if (room <= 0) return;
      const kept = chunk.subarray(0, room);
      this.#chunks.push(kept);
      this.#storedBytes += kept.length;
      return;
    }

    this.#chunks.push(chunk);
    this.#storedBytes += chunk.length;
    while (this.#storedBytes > this.limit) {
      const first = this.#chunks[0];
      if (first === undefined) break;
      const excess = this.#storedBytes - this.limit;
      if (first.length <= excess) {
        this.#chunks.shift();
        this.#storedBytes -= first.length;
      } else {
        this.#chunks[0] = first.subarray(excess);
        this.#storedBytes -= excess;
      }
    }
  }

  toText(maxBytes: number): { text: string; truncated: boolean } {
    const text = Buffer.concat(this.#chunks).toString("utf8");
    const cut = this.keep === "head" ? keepHead(text, maxBytes) : keepTail(text, maxBytes);
    return { text: cut.text, truncated: this.totalBytes > maxBytes };
  }
}
