import { z } from "zod";
import {
  DIFF_FLAGS,
  DiffModeSchema,
  FileStatusSchema,
  listChanges,
  resolveRange,
  type ChangedFile,
} from "../lib/changes.js";
import type { Git } from "../lib/git.js";
import { READ_ONLY, defineTool } from "./tool.js";

const PATCH_CONCURRENCY = 8;

const PatchOmittedSchema = z
  .enum(["binary", "denied", "size_limit"])
  .nullable()
  .describe(
    "Why `patch` is empty: a binary file, a path hidden by the path policy, or not enough of the " +
      "output budget left (request that file alone with `paths`).",
  );

export const getDiffTool = defineTool({
  name: "get_diff",
  title: "Get diff",
  description:
    "Get the unified diff between two commits, split per file. Defaults to pull-request semantics " +
    "(changes on head since it branched from base). Output is capped: files that don't fit have " +
    '`patchOmitted: "size_limit"`; fetch them separately with `paths`.',
  inputSchema: {
    base: z.string().min(1).describe("Base ref, e.g. `main` or a SHA."),
    head: z.string().min(1).default("HEAD").describe("Head ref. Defaults to HEAD."),
    mode: DiffModeSchema,
    paths: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe("Only include these files or directories (literal paths, not globs)."),
    contextLines: z.number().int().min(0).max(20).default(3),
    maxBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Total patch budget in bytes. Can't exceed the server's limit."),
  },
  outputSchema: {
    base: z.string(),
    head: z.string(),
    mergeBase: z.string().nullable(),
    files: z.array(
      z.object({
        path: z.string(),
        oldPath: z.string().nullable(),
        status: FileStatusSchema,
        additions: z.number().int(),
        deletions: z.number().int(),
        isBinary: z.boolean(),
        patch: z.string(),
        patchOmitted: PatchOmittedSchema,
      }),
    ),
    truncated: z.boolean().describe("True if any patch was omitted for size."),
  },
  annotations: { ...READ_ONLY, title: "Get diff" },

  async run(input, { config, paths, git }) {
    const pathspecs = (input.paths ?? []).map((p) => paths.normalize(p));
    const range = await resolveRange(git, input.base, input.head, input.mode);
    const budget = Math.min(input.maxBytes ?? Infinity, config.limits.maxDiffBytes);

    const changes = await listChanges(git, range.from, range.head, pathspecs);
    const readable = (file: ChangedFile) =>
      paths.isAllowed(file.path) && (file.oldPath === null || paths.isAllowed(file.oldPath));

    const patches = await mapWithConcurrency(changes, PATCH_CONCURRENCY, (file) =>
      file.isBinary || !readable(file)
        ? Promise.resolve(null)
        : filePatch(git, range.from, range.head, file, input.contextLines, budget),
    );

    let remaining = budget;
    let truncated = false;
    const files = changes.map((file, i) => {
      const patch = patches[i] ?? null;
      let patchOmitted: z.infer<typeof PatchOmittedSchema> = null;
      if (file.isBinary) patchOmitted = "binary";
      else if (!readable(file)) patchOmitted = "denied";
      else if (patch === null || Buffer.byteLength(patch) > remaining) patchOmitted = "size_limit";

      if (patchOmitted === "size_limit") truncated = true;
      if (patchOmitted !== null || patch === null) return { ...file, patch: "", patchOmitted };
      remaining -= Buffer.byteLength(patch);
      return { ...file, patch, patchOmitted };
    });

    return { base: range.base, head: range.head, mergeBase: range.mergeBase, files, truncated };
  },

  render(output) {
    const parts = output.files.map((f) =>
      f.patchOmitted === null ? f.patch : `# ${f.path}: patch omitted (${f.patchOmitted})\n`,
    );
    const footer = output.truncated
      ? "\n[truncated: some patches were omitted for size; request them with `paths`]"
      : "";
    return parts.join("") + footer;
  },
});

/**
 * Diffs one file. Running git per file (rather than splitting one big patch)
 * maps patches to files exactly, even for paths with unusual characters.
 * Returns null if the patch alone exceeds the budget.
 */
async function filePatch(
  git: Git,
  from: string,
  to: string,
  file: ChangedFile,
  contextLines: number,
  maxBytes: number,
): Promise<string | null> {
  const pathspecs = file.oldPath === null ? [file.path] : [file.oldPath, file.path];
  const output = await git.run(
    ["diff", ...DIFF_FLAGS, `-U${contextLines}`, from, to, "--", ...pathspecs],
    { maxBytes },
  );
  return output.truncated ? null : output.stdout;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
