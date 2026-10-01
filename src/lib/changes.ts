import { z } from "zod";
import { ErrorCode, ToolError } from "./errors.js";
import type { Git } from "./git.js";

/** Flags for every diff: no external programs, no colour, rename detection on. */
export const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"];

const MAX_LISTING_BYTES = 4 * 1024 * 1024;

export const DiffModeSchema = z
  .enum(["merge-base", "direct"])
  .default("merge-base")
  .describe(
    "`merge-base` diffs from where head branched off base (what a pull request shows, " +
      "like `base...head`). `direct` diffs the two commits as they are (`base..head`).",
  );

export const FileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type_changed",
]);

export interface Range {
  base: string;
  head: string;
  mergeBase: string | null;
  /** The commit the diff starts from: the merge base or `base`, depending on mode. */
  from: string;
}

export interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: z.infer<typeof FileStatusSchema>;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export async function resolveRange(
  git: Git,
  baseRef: string,
  headRef: string,
  mode: "merge-base" | "direct",
): Promise<Range> {
  const [base, head] = await Promise.all([git.resolveCommit(baseRef), git.resolveCommit(headRef)]);
  if (mode === "direct") return { base, head, mergeBase: null, from: base };

  const mergeBase = await git.mergeBase(base, head);
  if (mergeBase === null) {
    throw new ToolError(
      ErrorCode.InvalidRef,
      `${baseRef} and ${headRef} have no common ancestor; use mode "direct".`,
    );
  }
  return { base, head, mergeBase, from: mergeBase };
}

/** Lists files changed between two commits, in git's (path-sorted) order. */
export async function listChanges(
  git: Git,
  from: string,
  to: string,
  pathspecs: readonly string[],
): Promise<ChangedFile[]> {
  const args = (format: string) => [
    "diff",
    format,
    "-z",
    ...DIFF_FLAGS,
    from,
    to,
    "--",
    ...pathspecs,
  ];
  const [nameStatus, numstat] = await Promise.all([
    git.run(args("--name-status"), { maxBytes: MAX_LISTING_BYTES }),
    git.run(args("--numstat"), { maxBytes: MAX_LISTING_BYTES }),
  ]);
  if (nameStatus.truncated || numstat.truncated) {
    throw new ToolError(
      ErrorCode.TooLarge,
      "Too many changed files; narrow the diff with `paths`.",
    );
  }

  const statuses = parseNameStatus(nameStatus.stdout);
  const counts = parseNumstat(numstat.stdout);
  if (statuses.length !== counts.length) {
    throw new ToolError(ErrorCode.GitError, "git diff --name-status and --numstat disagree.");
  }

  return statuses.map((entry, i) => {
    const count = counts[i] ?? { additions: null, deletions: null };
    return {
      ...entry,
      additions: count.additions ?? 0,
      deletions: count.deletions ?? 0,
      isBinary: count.additions === null,
    };
  });
}

const STATUS_LETTERS: Record<string, ChangedFile["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type_changed",
};

/** `-z --name-status`: `M\0path\0` or, for renames and copies, `R100\0old\0new\0`. */
function parseNameStatus(stdout: string) {
  const tokens = stdout.split("\0");
  const entries: Pick<ChangedFile, "path" | "oldPath" | "status">[] = [];
  for (let i = 0; i + 1 < tokens.length;) {
    const letter = tokens[i]?.charAt(0) ?? "";
    const status = STATUS_LETTERS[letter] ?? "modified";
    if (letter === "R" || letter === "C") {
      entries.push({ status, oldPath: tokens[i + 1] ?? "", path: tokens[i + 2] ?? "" });
      i += 3;
    } else {
      entries.push({ status, oldPath: null, path: tokens[i + 1] ?? "" });
      i += 2;
    }
  }
  return entries;
}

/**
 * `-z --numstat`: `adds\tdels\tpath\0` or, for renames, `adds\tdels\t\0old\0new\0`.
 * Binary files report `-` for both counts, returned here as null.
 */
function parseNumstat(stdout: string) {
  const tokens = stdout.split("\0");
  const counts: { additions: number | null; deletions: number | null }[] = [];
  for (let i = 0; i + 1 < tokens.length;) {
    const [additions = "-", deletions = "-", path = ""] = (tokens[i] ?? "").split("\t");
    counts.push({
      additions: additions === "-" ? null : Number(additions),
      deletions: deletions === "-" ? null : Number(deletions),
    });
    i += path === "" ? 3 : 1;
  }
  return counts;
}
