# PLAN — mcp-repo-tools

Repo 1 of 3 in the code-review portfolio. An MCP server that gives agents read-only, policy-enforced
access to one local git repository, plus an opt-in, operator-configured `run_tests`.

This plan was written after the fact (2026-09-30): tasks 1–11 were built before the lead/builder
workflow was adopted. Statuses: `todo` · `in progress` · `done` · `blocked`.

## Tasks

| #   | Task                                                                   | Commit    | Status |
| --- | ---------------------------------------------------------------------- | --------- | ------ |
| 1   | Scaffold: TS, strict eslint, prettier, vitest, CI                      | `44af8a9` | done   |
| 2   | Typed tool errors, UTF-8-safe truncation                               | `55c6170` | done   |
| 3   | Config schema (Zod) and repo path policy (containment, allow/deny)     | `3421e46` | done   |
| 4   | Bounded process runner, hardened git wrapper, fixture repo builder     | `ae0cc84` | done   |
| 5   | `read_file`                                                            | `fbb076a` | done   |
| 6   | `search_code`                                                          | `accda09` | done   |
| 7   | `list_changed_files`, `get_diff`                                       | `5eec79c` | done   |
| 8   | `run_tests` (opt-in, configured targets, arg regexes, scrubbed env)    | `1c4369b` | done   |
| 9   | MCP server, stdio CLI, client integration tests; `--repo` must be root | `967cd2a` | done   |
| 10  | Streamable HTTP transport (loopback, bearer token, Host/Origin checks) | `05937a0` | done   |
| 11  | README, SECURITY.md, example config, CI action bumps, `prepare` script | `c97c3ed` | done   |
| 12  | Lead quality-gate audit of tasks 1–11                                  | —         | done   |
| 13a | Deny list gaps + `..foo` false positive in `resolveFile`               | —         | done   |
| 13b | HTTP: allowed Host names for non-loopback binds                        | —         | done   |

## Key decisions

- **git is the source of truth**: `search_code` = `git grep`, `read_file --ref` = `git cat-file`.
  No ripgrep dependency, `.gitignore` respected, every tool works at any commit.
- **Refs in, SHAs out**: refs are validated and resolved once, and outputs echo the SHAs so
  pr-review-agent can checkpoint against exact commits.
- **PR semantics by default**: `mode: merge-base` (`base...head`).
- **Budgets degrade per file**: `get_diff` fills a byte budget with whole patches. Omitted files stay
  listed with `patchOmitted` set to the reason.
- **Names are metadata, contents are policy**: denied files appear in change lists, but their contents
  never do.
- **Errors as `CODE: message` text**, not `structuredContent`, because clients validate
  `structuredContent` against the success schema.
- **A failing test run is a result, not an error.** gameable-tests-bench depends on this shape.
- **One repo per server, stateless HTTP** (a fresh server per request).
- **Tools are data** (`defineTool`), unit-tested against a real fixture repo that is built at test
  time.
- **Distribution**: installed as a git dependency, so `prepare` compiles on install. TypeScript is
  pinned to 6.0 until typescript-eslint supports 7.x.

## Open items

- `run_tests` at an arbitrary ref, via a temporary worktree (planned opt-in; see README limitations).

## Audit (task 12, 2026-09-30)

Baseline: lint, format, typecheck, 135 tests and build all green. Tests use real temp repos and a real
HTTP server, with no mocks. The security claims checked out: no shell, argv-only, refs resolved
once, and diffs are always commit-to-commit, so working-tree clean filters never run.

Findings, all reproduced:

1. **Deny list gaps (13a).** `vendor/x/.git/config` (a nested repo, whose remote URL may carry a
   token), `sub/.git`, `.envrc`, `.git-credentials` and `.aws/credentials` are all readable.
   `.git/**` only matches the top level.
2. **False PATH_DENIED (13a).** `resolveFile` treats any real path starting with `..` as an
   escape, so a file named `..foo.txt` can't be read. Low severity.
3. **HTTP non-loopback is unusable (13b).** `--host 0.0.0.0` with a token answers 403 "Host not
   allowed" to every client: the only allowed Host is the literal bind address.

Noted, not scheduled:

- `get_diff` computes every file's patch even after the budget is spent (one git process per file).
- Nested config objects (`limits`, `runTests`) aren't `.strict()`, so typos there are silently
  ignored.
