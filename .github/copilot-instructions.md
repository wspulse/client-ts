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
    - `feature/<name>` — new feature
    - `refactor/<name>` — restructure without behaviour change
    - `bugfix/<name>` — bug fix
    - `fix/<name>` — quick fix (e.g. config, docs, CI)
    - CI triggers on all four branch prefixes and on PRs targeting `main`/`develop`. Tags do **not** trigger CI (the tag is created after CI already passed). Open a PR into `develop`; `develop` requires status checks to pass.
- **Tests**: in `test/` directory. Cover happy path and at least one error path. Required for new public functions.
  - **Test-first for bug fixes**: **mandatory** — see Critical Rule 8 for the required step-by-step procedure. Do not touch production code without a prior failing test.
- **API compatibility**:
  - Exported symbols are a public contract. Changing or removing any exported identifier is a breaking change requiring a major version bump.
  - Mark deprecated symbols with `@deprecated` JSDoc tag before removal.
- **Error format**: error messages prefixed with `wspulse: <context>`.
- **Dependency policy**: zero runtime dependencies for browser; `ws` as peer dep for Node.js only. Justify any new dependency in the PR description.
- **Platform differences**: some options are Node.js-only. The most critical case: browsers prohibit custom headers on WebSocket handshake requests — the `WebSocket` API provides no mechanism to attach arbitrary headers to the `Upgrade` request. `dialHeaders` must be silently ignored in browser environments. Document any other Node.js-only option with a JSDoc note and ensure the implementation guards against it gracefully in browsers.

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
> This applies to both plan files and `doc/local/ai-learning.md`.

- **At the start of every session**: check whether `doc/local/plan/` contains
  an in-progress plan for the current task, and read `doc/local/ai-learning.md`
  (if it exists) to recall past mistakes and techniques before writing any code.
- **Plan mode**: when implementing a new feature or multi-file fix, save a plan
  to `doc/local/plan/<feature-name>.md` before starting. Keep it updated with
  completed steps and any plan changes throughout the session.
- **AI learning log**: at the end of a session where mistakes were made or
  reusable techniques were discovered, append a short entry to
  `doc/local/ai-learning.md`. Entry format:
  `Date` / `Issue or Learning` / `Root Cause` / `Prevention Rule`.
  Append only — never overwrite existing entries.

[contract-if]: https://github.com/wspulse/.github/blob/main/doc/contracts/client-interface.md
[contract-bh]: https://github.com/wspulse/.github/blob/main/doc/contracts/client-behaviour.md
