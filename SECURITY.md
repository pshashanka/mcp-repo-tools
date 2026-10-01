# Security

## Threat model

mcp-repo-tools sits between a model and a git repository. Neither one is trusted:

- **The repository** may be an untrusted checkout, such as a contributor's pull request. Its files,
  its `.git/config` and its test suite may all be hostile.
- **The model** reads that repository and can be steered by text in it (prompt injection). Assume
  any tool call can be adversarial.

The **operator** (whoever starts the server and writes the config file) is trusted. Every guarantee
below is enforced in the server, whatever the model asks for.

## Guarantees

| Area                | Guarantee                                                                                                                                                                  | Where                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Filesystem reads    | Only regular files inside the repo root, after symlink resolution, that pass the allow/deny globs                                                                          | `src/lib/paths.ts`                            |
| Secrets             | `.git/**`, `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, SSH keys, `.npmrc`, `.netrc`, `.pypirc` are never readable or searchable, at any ref. Matching is case-insensitive | `DEFAULT_DENY_GLOBS` in `src/config.ts`       |
| Command injection   | No shell anywhere; argv arrays only; refs starting with `-` are rejected; `--end-of-options` and `--` separate refs and paths; literal pathspecs by default                | `src/lib/git.ts`, `src/lib/exec.ts`           |
| Hostile git config  | System/global config ignored; `core.fsmonitor`, `core.hooksPath`, `diff.external` disabled; `--no-ext-diff --no-textconv`; no lazy fetch; no optional locks                | `src/lib/git.ts`                              |
| Resource exhaustion | Byte caps on every output (the client can lower them, not raise them); timeouts on every subprocess; files over 10 MiB refused                                             | `src/config.ts`, `src/lib/exec.ts`            |
| Code execution      | Only `run_tests`, only with `--allow-run-tests`, only operator-configured argv, only args matching operator regexes                                                        | `src/tools/run-tests.ts`                      |
| Secret leakage      | Test processes get a minimal env (`PATH`, `HOME`, `TMPDIR`, `LANG` plus an explicit allowlist). Unexpected errors are reported without stack traces or details             | `src/tools/run-tests.ts`, `src/lib/errors.ts` |
| Network exposure    | HTTP binds to loopback; non-loopback needs a bearer token; Host/Origin validated against DNS rebinding                                                                     | `src/transports/http.ts`                      |
| Self-escalation     | Config is read only from `--config`, never from the served repo                                                                                                            | `src/index.ts`                                |

## Non-guarantees

- **`run_tests` is not a sandbox.** It executes the repository's code as your user. That code can
  read your home directory, use the network and write files. The env scrubbing and timeouts limit
  accidental leakage and runaway processes; they do not contain malicious code. To run tests from
  untrusted PRs, run the whole server in a container or VM with no credentials mounted.
- **Changed file names are visible.** `list_changed_files` and `get_diff` list every changed path,
  including denied ones (their contents are withheld). Don't rely on the deny list to hide that a
  file exists.
- **Git's own parsing is trusted.** A vulnerability in git itself is out of scope; keep git up to
  date.

## Reporting a vulnerability

Please open a private security advisory on GitHub rather than a public issue.
