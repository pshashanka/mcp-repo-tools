import { z } from "zod";
import { ErrorCode, ToolError } from "../lib/errors.js";
import { keepHead } from "../lib/truncate.js";
import { READ_ONLY, defineTool } from "./tool.js";

const MAX_LINE_BYTES = 500;
const MAX_GREP_BYTES = 2 * 1024 * 1024;

const MatchSchema = z.object({
  path: z.string(),
  line: z.number().int(),
  text: z.string(),
  before: z.array(z.string()).optional(),
  after: z.array(z.string()).optional(),
});

type Match = z.infer<typeof MatchSchema>;

export const searchCodeTool = defineTool({
  name: "search_code",
  title: "Search code",
  description:
    "Search tracked files for a string or regex (git grep). Searches the working tree by default, " +
    "or a specific commit with `ref`. Binary files and files hidden by the server's path policy " +
    "are skipped. Prefer a literal `query`; set `regex` for POSIX extended regular expressions.",
  inputSchema: {
    query: z.string().min(1).max(500),
    regex: z.boolean().default(false).describe("Treat `query` as a POSIX extended regex."),
    caseSensitive: z.boolean().default(false),
    pathGlobs: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe("Only search matching paths, e.g. `src/**/*.ts`. `*` does not cross `/`."),
    ref: z
      .string()
      .optional()
      .describe("Commit, branch or tag to search. Omit for the working tree."),
    maxResults: z.number().int().min(1).max(500).default(100),
    contextLines: z.number().int().min(0).max(5).default(0),
  },
  outputSchema: {
    ref: z.string().nullable().describe("Resolved commit SHA, or null for the working tree."),
    matches: z.array(MatchSchema),
    truncated: z.boolean().describe("True if there were more matches than were returned."),
  },
  annotations: { ...READ_ONLY, title: "Search code" },

  async run(input, { config, paths, git }) {
    const pathGlobs = (input.pathGlobs ?? []).map(validateGlob);
    const sha = input.ref === undefined ? null : await git.resolveCommit(input.ref);
    const maxResults = Math.min(input.maxResults, config.limits.maxSearchResults);

    const grepArgs = [
      "grep",
      "-n",
      "-I",
      "-z",
      "--no-color",
      "--full-name",
      input.regex ? "-E" : "-F",
      ...(input.caseSensitive ? [] : ["-i"]),
      "-e",
      input.query,
    ];
    const revision = sha === null ? [] : [sha];
    // Excluding denied paths here saves output budget; the isAllowed filter below is what enforces it.
    const excludes = config.denyGlobs.map((glob) => `:(exclude,icase)${glob}`);

    const first = await git.run([...grepArgs, ...revision, "--", ...pathGlobs, ...excludes], {
      maxBytes: MAX_GREP_BYTES,
      okExitCodes: [0, 1],
      pathspecs: "glob",
    });

    const prefix = sha === null ? "" : `${sha}:`;
    const allowed = parseGrep(first.stdout, prefix, first.truncated).filter((m) =>
      paths.isAllowed(m.path),
    );
    const matches: Match[] = allowed.slice(0, maxResults);
    const truncated = allowed.length > maxResults || first.truncated;

    if (input.contextLines > 0 && matches.length > 0) {
      // `git grep -z` prints match and context lines identically, so context is a
      // second pass over just the files that matched, joined back by line number.
      const files = [...new Set(matches.map((m) => m.path))];
      const second = await git.run(
        [...grepArgs, "-C", String(input.contextLines), ...revision, "--", ...files],
        { maxBytes: MAX_GREP_BYTES, okExitCodes: [0, 1] },
      );
      const linesByFile = new Map<string, Map<number, string>>();
      for (const { path, line, text } of parseGrep(second.stdout, prefix, second.truncated)) {
        let lines = linesByFile.get(path);
        if (lines === undefined) linesByFile.set(path, (lines = new Map<number, string>()));
        lines.set(line, text);
      }
      for (const match of matches) {
        const lines = linesByFile.get(match.path) ?? new Map<number, string>();
        match.before = collect(lines, match.line - input.contextLines, match.line - 1);
        match.after = collect(lines, match.line + 1, match.line + input.contextLines);
      }
    }

    return { ref: sha, matches, truncated };
  },

  render(output) {
    if (output.matches.length === 0) return "No matches.";
    const blocks = output.matches.map((m) => {
      const before = (m.before ?? []).map(
        (text, i, all) => `${m.path}-${m.line - all.length + i}-${text}`,
      );
      const after = (m.after ?? []).map((text, i) => `${m.path}-${m.line + i + 1}-${text}`);
      return [...before, `${m.path}:${m.line}:${m.text}`, ...after].join("\n");
    });
    const separator = output.matches.some((m) => m.before || m.after) ? "\n--\n" : "\n";
    const footer = output.truncated ? "\n[truncated: more matches exist; narrow the query]" : "";
    return blocks.join(separator) + footer;
  },
});

/** Pathspec magic (":(...)") and anything that could leave the repo are rejected. */
function validateGlob(glob: string): string {
  if (
    glob.startsWith(":") ||
    glob.startsWith("/") ||
    glob.includes("\0") ||
    glob.split("/").includes("..")
  ) {
    throw new ToolError(ErrorCode.InvalidInput, `Invalid path glob: ${JSON.stringify(glob)}`);
  }
  return glob;
}

/**
 * Parses `git grep -n -z` output: `<path>\0<line>\0<text>\n` per line, with
 * `--\n` between non-adjacent context groups. Paths are NUL-terminated, so
 * they may safely contain `:` or newlines.
 */
function parseGrep(stdout: string, prefix: string, truncated: boolean): Match[] {
  const matches: Match[] = [];
  let i = 0;
  while (i < stdout.length) {
    if (stdout.startsWith("--\n", i)) {
      i += 3;
      continue;
    }
    const pathEnd = stdout.indexOf("\0", i);
    const lineEnd = pathEnd === -1 ? -1 : stdout.indexOf("\0", pathEnd + 1);
    let textEnd = lineEnd === -1 ? -1 : stdout.indexOf("\n", lineEnd + 1);
    if (textEnd === -1) {
      // A record cut off by the output cap is dropped; otherwise it's the final line without "\n".
      if (truncated || lineEnd === -1) break;
      textEnd = stdout.length;
    }

    const path = stdout.slice(i, pathEnd);
    matches.push({
      path: path.startsWith(prefix) ? path.slice(prefix.length) : path,
      line: Number(stdout.slice(pathEnd + 1, lineEnd)),
      text: clipLine(stdout.slice(lineEnd + 1, textEnd)),
    });
    i = textEnd + 1;
  }
  return matches;
}

function clipLine(text: string): string {
  const clipped = keepHead(text, MAX_LINE_BYTES);
  return clipped.truncated ? `${clipped.text}…` : clipped.text;
}

function collect(lines: Map<number, string>, from: number, to: number): string[] {
  const result: string[] = [];
  for (let line = Math.max(from, 1); line <= to; line++) {
    const text = lines.get(line);
    if (text !== undefined) result.push(text);
  }
  return result;
}
