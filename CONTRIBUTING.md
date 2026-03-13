# Contributing to wspulse/client-ts

Thank you for your interest in contributing. This document describes the process and conventions expected for all contributions.

## Before You Start

- Open an issue to discuss significant changes before starting work.
- For bug fixes, write a failing test that reproduces the issue before modifying production code. The PR must include this test.
- For new features, confirm scope and API design in an issue first.

## Development Setup

```bash
git clone https://github.com/wspulse/client-ts
cd client-ts
npm install
```

Requires: Node.js 20+, npm 10+.

## Pre-Commit Checklist

Run `make check` before every commit. It runs in order:

1. `make fmt` — formats all source files with Prettier
2. `make lint` — runs ESLint and `tsc --noEmit`; must pass with zero warnings
3. `make test` — runs vitest; must pass

If any step fails, do not commit.

## Commit Messages

Follow the format in [`.github/instructions/commit-message-instructions.md`](.github/instructions/commit-message-instructions.md):

```
<type>: <subject>

1.<reason> → <change>
```

## Branch Strategy

Never push directly to `develop` or `main`. Use:

- `feature/<name>` — new feature
- `refactor/<name>` — restructure without behaviour change
- `bugfix/<name>` — bug fix
- `fix/<name>` — quick fix (config, docs, CI)

## Tests

- Tests live in `test/`.
- Cover happy path and at least one error path.
- New public functions require tests.
