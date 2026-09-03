# opencode-swe-factory

Package to help OpenCode self-improve over time.

## Stack
- Language/runtime:
- Framework:
- Package manager:

## Commands
- Install:
- Dev/run:
- Test:
- Lint/typecheck:
- Build:

## Conventions
Cross-project coding principles live in the user's global instructions. Project coding conventions live in `CLEANCODE.md`; keep detailed code-quality rules there so this file stays focused on project context.

This section is only for what's specific to *this* repo:
- Code style:
- Testing approach:
- Commit message format:

## Architecture
(Placeholder — fill in once the system has real shape. High-level modules/services and how they talk to each other. Update this when the shape changes, not on every commit.)

## Context files
Keep these current — they're what gives any session, model, or tool continuity without re-deriving history from scratch.

- **AGENTS.md** (this file) — stack, commands, repo-specific conventions, architecture. Update only when one of those actually changes.
- **CLAUDE.md** — pointer to this file only. Don't duplicate content into it.
- **CLEANCODE.md** — coding conventions agents should follow while editing code. Update when recurring code-quality preferences or project-specific patterns become clear.
- **docs/journal.md** — append-only session log. Never edit past entries; if something turns out wrong, say so in a new one.
- **docs/decisions.md** — append-only log of significant technical decisions. A reversed decision gets a new entry that supersedes the old one.
- **docs/designs/** — design documents. Save working versions here rather than leaving them only in chat.
- **TODO.md** — current and near-term work. Tasks carry an id, a manual/agent tag, and optional `depends-on` links so parallel-safe work can be computed.

**Before starting nontrivial work:** read this file, read `CLEANCODE.md`, skim recent journal entries, and check `TODO.md`.
**After finishing a session:** append a journal entry, update `TODO.md`, and append a decision entry if a load-bearing decision was made.
