---
applyTo: "**"
---

# Commit Message Rules

## Format

```
<type>: <subject>

1.<reason> → <change>
2.<reason> → <change>
3.<reason> → <change>
```

- **Header**: must include type and subject, max 50 characters.
- **Second line**: blank (required).
- **Body** (line 3+): numbered items. Each item states the reason first, then the change. Keep each item under 50 characters. Max 3 items.
- Body is optional for trivial changes.

---

## Type Definitions

| Type       | When to use                                                                   |
| ---------- | ----------------------------------------------------------------------------- |
| `feat`     | New code for a new feature, support method, or interface                      |
| `fix`      | Fix a bug or incorrect behavior                                               |
| `refactor` | Restructure code for readability or maintainability without changing behavior |
| `doc`      | Documentation-only or comment-only changes                                    |
| `style`    | Code formatting, parameter reordering, or other non-functional changes        |
| `test`     | Add or modify tests (unit, integration, test fixtures)                        |
| `chore`    | Dependency upgrades, tooling changes, or build configuration                  |
| `revert`   | Revert one or more previous commits                                           |
| `merge`    | Merge operations                                                              |
| `sync`     | Resolve conflicts between branches                                            |

---

## Rules

1. Each commit contains exactly one logical change. Do not mix unrelated modifications.
2. Header max 50 characters. Body items max 50 characters each, max 3 items.
3. Use a colon `:` between type and subject.
4. All text in English.
5. Use only common, universally recognized abbreviations; avoid half-word truncations.
6. **No AI signatures** — do not append any AI-generated trailer, co-authorship line, or signature.

---

## Examples

```
feat: add backoff function with equal jitter

1.Need reconnect delay matching Go impl → add backoff()
2.Cap shift at 62 to prevent overflow → guard in function
```
