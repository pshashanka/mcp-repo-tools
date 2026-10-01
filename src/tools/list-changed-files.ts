import picomatch from "picomatch";
import { z } from "zod";
import { DiffModeSchema, FileStatusSchema, listChanges, resolveRange } from "../lib/changes.js";
import { READ_ONLY, defineTool } from "./tool.js";

export const listChangedFilesTool = defineTool({
  name: "list_changed_files",
  title: "List changed files",
  description:
    "List files changed between two commits, with status, line counts, and whether each file is " +
    "a test (by the server's test globs). Cheap; call this before get_diff to decide what to read. " +
    "Paths of changed files are always listed, even ones whose contents the path policy hides.",
  inputSchema: {
    base: z.string().min(1).describe("Base ref, e.g. `main` or a SHA."),
    head: z.string().min(1).default("HEAD").describe("Head ref. Defaults to HEAD."),
    mode: DiffModeSchema,
    paths: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe("Only include these files or directories (literal paths, not globs)."),
  },
  outputSchema: {
    base: z.string().describe("Resolved base SHA."),
    head: z.string().describe("Resolved head SHA."),
    mergeBase: z.string().nullable().describe("Merge-base SHA in `merge-base` mode, else null."),
    files: z.array(
      z.object({
        path: z.string(),
        oldPath: z.string().nullable().describe("Previous path for renames and copies."),
        status: FileStatusSchema,
        additions: z.number().int(),
        deletions: z.number().int(),
        isBinary: z.boolean(),
        isTest: z.boolean(),
      }),
    ),
  },
  annotations: { ...READ_ONLY, title: "List changed files" },

  async run(input, { config, paths, git }) {
    const pathspecs = (input.paths ?? []).map((p) => paths.normalize(p));
    const range = await resolveRange(git, input.base, input.head, input.mode);
    const isTest = picomatch(config.testGlobs, { dot: true });

    const files = await listChanges(git, range.from, range.head, pathspecs);
    return {
      base: range.base,
      head: range.head,
      mergeBase: range.mergeBase,
      files: files.map((file) => ({ ...file, isTest: isTest(file.path) })),
    };
  },

  render(output) {
    const lines = output.files.map((f) => {
      const name = f.oldPath === null ? f.path : `${f.oldPath} -> ${f.path}`;
      const counts = f.isBinary ? "binary" : `+${f.additions} -${f.deletions}`;
      return `${f.status.padEnd(12)} ${counts.padEnd(12)} ${name}${f.isTest ? "  [test]" : ""}`;
    });
    const header = `${output.files.length} files changed (${output.mergeBase === null ? "direct" : "since merge-base"})`;
    return [header, ...lines].join("\n");
  },
});
