# Clean Code Conventions

Project-specific coding standards for agents and humans. Keep this practical and update it when conventions become clear from real work.

## Core principles

- Prefer simple, direct solutions over clever abstractions.
- Keep changes small, focused, and reviewable.
- Optimize for readability and maintainability before novelty.
- Prefer simple, readable code over compact code. Never pack a function into one dense line when plain multi-step code says the same thing more clearly — cleverness that costs readability is a bug.
- Do not introduce abstractions until there are at least two real call sites or a clear present need.
- Surface ambiguity, conflicting requirements, or risky tradeoffs instead of guessing silently.

## Structure

- Always keep types and constants in their own dedicated files (e.g. `types.ts`, `constants.ts`), separate from implementation code — do this from the start, not only when a file grows large.
- Avoid god files and oversized components/modules. Prefer small files — when a file grows past what fits comfortably in your head, split further into their own dedicated files.
- Put reusable logic in the project's established `lib`/`utils`/service layer once reuse is real.
- Keep code close to where it is used until it has a reason to move.
- Prefer explicit names that describe domain intent over generic names like `data`, `item`, or `helper`.

## Folder organization

- Group files by domain into subfolders; never let one folder accumulate a large unstructured file list. As of 2026-09-08, `src/core` is organized into domain folders (`db/`, `lessons/`, `documents/`, `tasks/`, `evidence/`, `models/`, `routing-replay/`, `backup/`) with only cross-cutting singletons left at its root (`index.ts` barrel, `constants.ts`, `config.ts`, `feature-toggles.ts`, `diagnostics.ts`, `paths.ts`, `secrets.ts`, `project-identity.ts`).
- New core files go into the domain folder that matches their concern, not the core root. Only add a file to `src/core` root if it is genuinely cross-cutting (used across most domains).
- When any folder approaches ~20 files, split it into sub-domain folders the same way (e.g. `lessons/` would naturally split retrieval concerns into `lessons/retrieval/`).
- Prefer singular, domain-named folders that match the file family inside them; keep `-constants` files beside the module they parameterize.

## Type safety

- Avoid `any`, broad casts, non-null assertions, and ignored type errors unless there is a documented reason.
- Model domain states explicitly instead of relying on loose objects or sentinel values.
- Validate external input at boundaries.

## Error handling

- Handle expected failures deliberately.
- Do not swallow errors silently.
- Return or throw errors in the style already used by the project.
- Include enough context for debugging without leaking secrets or sensitive data.

## Testing

- Add or update tests for behavior changes when the project has a test setup.
- Prefer behavior-focused tests over brittle implementation tests.
- If tests cannot be run or do not exist yet, say so in the final report.

## Cleanup before finishing

- Remove dead code, debug logging, commented-out experiments, and unused imports.
- Do not leave TODO/FIXME comments unless they describe a real follow-up task also recorded in `TODO.md`.
- Run the relevant format, lint, typecheck, and test commands from `AGENTS.md` when available.
