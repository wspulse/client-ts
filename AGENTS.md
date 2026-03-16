# AGENTS.md — wspulse/client-ts

This file is the entry point for all AI coding agents (GitHub Copilot, Codex,
Cursor, Claude, etc.). Full working rules are in
`.github/copilot-instructions.md` — read it completely before
making any changes.

---

## Quick Reference

**Package**: `@wspulse/client-ts` | **Module system**: ESM-first

**Key files**:

- `src/client.ts` — `connect()` entry point, `WspulseClient` implementation
- `src/options.ts` — `ClientOptions` interface, `resolveOptions()` defaults
- `src/frame.ts` — `Frame` interface
- `src/errors.ts` — `ConnectionClosedError`, `RetriesExhaustedError`, `ConnectionLostError`
- `src/backoff.ts` — `backoff()` exponential delay function
- `src/index.ts` — public re-exports

**Pre-commit gate**: `make check` (fmt → lint → test)

---

## Non-negotiable Rules

1. **Read before write** — read the target file before any edit.
2. **Contract compliance** — API and behaviour must match the interface and behaviour contracts.
3. **Backoff formula** — must match `client-go` exactly. Any deviation is a bug.
4. **No breaking changes without version bump.**
5. **No hardcoded secrets.**
6. **Minimal changes** — one concern per edit; no drive-by refactors.

---

## Session Protocol

> `doc/local/` is git-ignored. Never commit files under it.

- **Start of session**: read `doc/local/ai-learning.md` (if present) and check
  `doc/local/plan/` for any in-progress plan.
- **Feature work**: save plan to `doc/local/plan/<feature-name>.md` first.
- **End of session**: append mistakes/learnings to `doc/local/ai-learning.md`.
  Format: `Date` / `Issue or Learning` / `Root Cause` / `Prevention Rule`.
