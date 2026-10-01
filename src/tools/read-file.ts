import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ErrorCode, ToolError } from "../lib/errors.js";
import { keepHead } from "../lib/truncate.js";
import { READ_ONLY, defineTool, type ToolContext } from "./tool.js";

/** Files above this are refused outright; maxFileBytes then caps what's returned. */
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

export const readFileTool = defineTool({
  name: "read_file",
  title: "Read file",
  description:
    "Read a text file from the repository, optionally a line range, either from the working tree " +
    "or at a specific commit (`ref`). Use `ref` to compare a file before and after a change. " +
    "Output is capped; if `truncated` is true, request a later `startLine`.",
  inputSchema: {
    path: z.string().min(1).describe("Repo-relative path, e.g. `src/index.ts`."),
    ref: z
      .string()
      .optional()
      .describe("Commit, branch or tag to read from. Omit to read the working tree."),
    startLine: z.number().int().min(1).optional().describe("First line to return (1-based)."),
    endLine: z.number().int().min(1).optional().describe("Last line to return (inclusive)."),
  },
  outputSchema: {
    path: z.string(),
    ref: z.string().nullable().describe("Resolved commit SHA, or null for the working tree."),
    startLine: z.number().int(),
    endLine: z.number().int().describe("Last line actually returned."),
    totalLines: z.number().int(),
    isBinary: z.boolean(),
    content: z.string(),
    truncated: z.boolean(),
  },
  annotations: { ...READ_ONLY, title: "Read file" },

  async run(input, context) {
    if (input.startLine !== undefined && input.endLine !== undefined) {
      if (input.endLine < input.startLine) {
        throw new ToolError(ErrorCode.InvalidInput, "endLine must be >= startLine.");
      }
    }

    const { path, ref, bytes } =
      input.ref === undefined
        ? await readWorkingTree(input.path, context)
        : await readAtCommit(input.path, input.ref, context);

    const startLine = input.startLine ?? 1;
    if (looksBinary(bytes)) {
      return {
        path,
        ref,
        startLine,
        endLine: startLine - 1,
        totalLines: 0,
        isBinary: true,
        content: "",
        truncated: false,
      };
    }

    const lines = splitLines(bytes.toString("utf8"));
    if (startLine > Math.max(lines.length, 1)) {
      throw new ToolError(
        ErrorCode.InvalidInput,
        `startLine ${startLine} is past the end of ${path} (${lines.length} lines).`,
      );
    }
    const requestedEnd = Math.min(input.endLine ?? lines.length, lines.length);
    const selected = takeLinesWithinBudget(
      lines.slice(startLine - 1, requestedEnd),
      context.config.limits.maxFileBytes,
    );

    return {
      path,
      ref,
      startLine,
      endLine: startLine + selected.lineCount - 1,
      totalLines: lines.length,
      isBinary: false,
      content: selected.text,
      truncated: selected.truncated,
    };
  },

  render(output) {
    const source = output.ref === null ? "working tree" : output.ref.slice(0, 12);
    if (output.isBinary) return `${output.path} (${source}) is a binary file.`;

    const header = `${output.path} (${source}) lines ${output.startLine}-${output.endLine} of ${output.totalLines}`;
    const footer = output.truncated
      ? `\n[truncated: continue with startLine ${output.endLine + 1}]`
      : "";
    return `${header}\n\n${output.content}${footer}`;
  },
});

async function readWorkingTree(input: string, { paths }: ToolContext) {
  const file = await paths.resolveFile(input);
  if (file.size > MAX_SOURCE_BYTES) throw tooLarge(file.path);
  return { path: file.path, ref: null, bytes: await readFile(file.absolutePath) };
}

async function readAtCommit(input: string, ref: string, { paths, git }: ToolContext) {
  const path = paths.normalize(input);
  paths.assertAllowed(path);
  const sha = await git.resolveCommit(ref);

  // `cat-file blob` returns raw bytes with no textconv or filters applied.
  const output = await git.run(["cat-file", "blob", `${sha}:${path}`], {
    maxBytes: MAX_SOURCE_BYTES,
    okExitCodes: [0, 128],
  });
  if (output.exitCode === 128) {
    throw new ToolError(ErrorCode.NotFound, `No such file at ${sha.slice(0, 12)}: ${path}`);
  }
  if (output.truncated) throw tooLarge(path);
  return { path, ref: sha, bytes: Buffer.from(output.stdout, "utf8") };
}

/** Same heuristic as git: a NUL byte in the first 8000 bytes means binary. */
function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/** Splits into lines without counting a trailing newline as an extra empty line. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Takes whole lines until the byte budget runs out (or part of the first line, if it alone is too big). */
function takeLinesWithinBudget(lines: string[], maxBytes: number) {
  let bytes = 0;
  let count = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line) + 1;
    if (bytes + lineBytes > maxBytes) break;
    bytes += lineBytes;
    count++;
  }

  if (count === 0 && lines.length > 0) {
    return { text: keepHead(lines[0] ?? "", maxBytes).text, lineCount: 1, truncated: true };
  }
  const text = lines.slice(0, count).join("\n") + (count > 0 ? "\n" : "");
  return { text, lineCount: count, truncated: count < lines.length };
}

function tooLarge(path: string): ToolError {
  return new ToolError(
    ErrorCode.TooLarge,
    `${path} is larger than ${MAX_SOURCE_BYTES / 1024 / 1024} MiB and can't be read.`,
  );
}
