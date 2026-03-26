# Copilot Instructions — wspulse/client-ts

## Project Overview

wspulse/client-ts is a **WebSocket client library for TypeScript/JavaScript** with automatic reconnection and exponential backoff. Package name: `@wspulse/client-ts`. Supports both browser (native WebSocket) and Node.js (`ws` package as peer dependency).

## Architecture

- **`src/client.ts`** — `connect()` entry point and internal `WspulseClient` class. Manages WebSocket lifecycle, read loop, write loop, and reconnect loop.
- **`src/options.ts`** — `ClientOptions` interface and `resolveOptions()` to merge with defaults.
- **`src/codec.ts`** — `Codec` interface and `JSONCodec` default implementation. Mirrors Go `core` module's `Codec`.
- **`src/frame.ts`** — `Frame` interface (id, event, payload — all optional).
- **`src/errors.ts`** — Error classes: `ConnectionClosedError`, `RetriesExhaustedError`, `ConnectionLostError`.
- **`src/backoff.ts`** — `backoff()` function for exponential delay with equal jitter (matches Go implementation).
- **`src/index.ts`** — Public re-exports.

## Development Workflow

```bash
make fmt        # format with Prettier
make lint       # ESLint + tsc --noEmit
make test       # vitest run
make check      # prettier --check + lint + test (pre-commit gate)
make build      # tsup → dist/
make test-cover # vitest with v8 coverage
make clean      # remove dist/ and coverage/
```

## Conventions

- **TypeScript**: strict mode, ES2022 target, NodeNext module resolution.
- **Naming**: camelCase for functions/variables, PascalCase for types/classes/interfaces. No abbreviations in exported names — write `ConnectionClosedError`, not `ConnClosedErr`.
- **No emojis** in documentation files.
- **Git**:
  - Follow the commit message rules in [commit-message-instructions.md](instructions/commit-message-instructions.md).
  - All commit messages in English.
  - Each commit must represent exactly one logical change.
  - Before every commit, run `make check`.
  - **Branch strategy**: never push directly to `develop` or `main`.
    - `feat/<name>` or `feature/<name>` — new feature
    - `refactor/<name>` — restructure without behaviour change
    - `bugfix/<name>` — bug fix
    - `fix/<name>` — quick fix (e.g. config, docs, CI)
    - `chore/<name>` — maintenance, CI/CD, dependencies, docs
    - CI triggers on all branch prefixes above and on PRs targeting `main`/`develop`. Tags do **not** trigger CI (the tag is created after CI already passed). Open a PR into `develop`; `develop` requires status checks to pass.
- **Tests**: in `test/` directory. Cover happy path and at least one error path. Required for new public functions.
  - **Test-first for bug fixes**: **mandatory** — see Critical Rule 8 for the required step-by-step procedure. Do not touch production code without a prior failing test.
- **API compatibility**:
  - Exported symbols are a public contract. Changing or removing any exported identifier is a breaking change requiring a major version bump.
  - Mark deprecated symbols with `@deprecated` JSDoc tag before removal.
- **Error format**: error messages prefixed with `wspulse: <context>`.
- **Dependency policy**: zero runtime dependencies for browser; `ws` as peer dep for Node.js only. Justify any new dependency in the PR description.
- **Platform differences**: some options are Node.js-only. The most critical case: browsers prohibit custom headers on WebSocket handshake requests — the `WebSocket` API provides no mechanism to attach arbitrary headers to the `Upgrade` request. `dialHeaders` must be silently ignored in browser environments. Document any other Node.js-only option with a JSDoc note and ensure the implementation guards against it gracefully in browsers.
- **File encoding**: all files must be UTF-8 without BOM. Do not use any other encoding.

## Critical Rules

1. **Read before write** — always read the target file, the [interface contract][contract-if], and the [behaviour contract][contract-bh] fully before editing.
2. **Minimal changes** — one concern per edit; no drive-by refactors.
3. **No hardcoded secrets** — all configuration via environment variables.
4. **Contract compliance** — API surface and behaviour must match the [interface contract][contract-if] and [behaviour contract][contract-bh]. When in doubt, re-read both contracts.
5. **Backoff formula parity** — must produce the same distribution as `client-go`. Any deviation is a bug.
6. **Resource lifecycle** — every timer, listener, and WebSocket instance must have an explicit cleanup path. `close()` must not leak resources (timers, event listeners, pending Promises).
7. **No breaking changes without version bump** — never rename, remove, or change the signature of an exported symbol without bumping the major version. When unsure, add alongside the old symbol and deprecate.
8. **STOP — test first, fix second** — when a bug is discovered or reported, do NOT touch production code until a failing test exists. Follow this exact sequence without skipping or reordering:
   1. Write a failing test that reproduces the bug.
   2. Run the test and confirm it **fails** (proving the test actually catches the bug).
   3. Fix the production code.
   4. Run the test again and confirm it **passes**.
   5. Run `make check` to verify nothing else broke.
   6. If you are about to edit production code and no failing test exists yet — stop and go back to step 1.
9. **STOP — before every commit, verify this checklist:**
   1. Run `make check` (fmt → lint → test) and confirm it passes. Skip if the commit contains only non-code changes (e.g. documentation, comments, Markdown).
   2. Run GitHub Copilot code review (`github.copilot.chat.review.changes`) on the working-tree diff and resolve every comment before proceeding.
   3. Commit message follows [commit-message-instructions.md](instructions/commit-message-instructions.md): correct type, subject ≤ 50 chars, numbered body items stating reason → change.
   4. This commit contains exactly one logical change — no unrelated modifications.
   5. If any item fails — fix it before committing.
10. **Accuracy** — if you have questions or need clarification, ask the user. Do not make assumptions without confirming.
11. **Language consistency** — when the user writes in Traditional Chinese, respond in Traditional Chinese; otherwise respond in English.
12. **Throw policy — fail early, never at steady-state runtime** — Enforce errors at the earliest possible phase:
    1. Prefer compile-time enforcement via the type system.
    2. **Setup-time programmer errors** (invalid options, missing required config): throw immediately. These indicate a caller logic bug; crashing at startup is correct.
    3. **Steady-state runtime** (`send`, `close`, reconnect loops, and any code that runs after connection is established): reject Promises or emit errors via callbacks, never throw synchronously.

## Session Protocol

> Files under `doc/local/` are git-ignored and must **never** be committed.
> This includes plan files (`doc/local/plan/`), review records, and the AI learning log (`doc/local/ai-learning.md`).

### Start of every session — MANDATORY

**Do these steps before writing any code:**

1. Read `doc/local/ai-learning.md` **in full** to recall past mistakes. If the file is missing or empty, create it with the table header (see format below) before proceeding.
2. Check `doc/local/plan/` for any in-progress plan and read it fully.

### During feature work

For any new feature or multi-file fix: save a plan to `doc/local/plan/<feature-name>.md` **before starting**. Keep it updated with completed steps throughout the session.

### Review records

After conducting any review (code review, plan review, design review, PR review, etc.), record the findings for cross-session context:

- **Where to write**: this repo's `doc/local/`. If working in a multi-module workspace, also write to the workspace root's `doc/local/`.
- **Single truth**: write the full record in one location; the other location keeps a brief summary with a file path reference to the full record.
- **Acceptable formats**:
  1. Update the relevant plan file in `doc/local/plan/` with the review outcome.
  2. Dedicated review file in `doc/local/` if no relevant plan exists.
- **What to record**: review type, key findings, decisions made, action items, and resolution status.

### End of every session — MANDATORY

**Before closing the session, complete this checklist without exception:**

1. Append at least one entry to `doc/local/ai-learning.md` — **even if no mistakes were made**. Record what you confirmed, what technique worked, or what you observed. An empty file is a sign of non-compliance.
2. Update any in-progress plan in `doc/local/plan/` to reflect completed steps.
3. Verify `make check` passes in every module you edited.

**Entry format** for `doc/local/ai-learning.md`:

```
| Date       | Issue or Learning | Root Cause | Prevention Rule |
| ---------- | ----------------- | ---------- | --------------- |
| YYYY-MM-DD | <what happened or what you learned> | <why it happened> | <how to avoid it next time> |
```

**Writing to `ai-learning.md` is not optional. It is the primary cross-session improvement mechanism. An empty file proves the session protocol was ignored.**

[contract-if]: https://github.com/wspulse/.github/blob/main/doc/contracts/client/interface.md
[contract-bh]: https://github.com/wspulse/.github/blob/main/doc/contracts/client/behaviour.md
