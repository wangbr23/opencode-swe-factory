# opencode-swe-factory

Package to help OpenCode self-improve over time.

## Stack
- Language/runtime: TypeScript on Bun
- Framework: None
- Package manager: Bun

## Commands
- Install: `bun install`
- Dev/run: `bun run dev`
- Test: `bun test`
- Lint/typecheck: `bun run typecheck`
- Build: `bun run build`

## Conventions
Cross-project coding principles live in the user's global instructions. Project coding conventions live in `CLEANCODE.md`; keep detailed code-quality rules there so this file stays focused on project context.

This section is only for what's specific to *this* repo:
- Code style:
- Testing approach: Behavior-focused Bun tests, SQLite migration/concurrency tests, OpenCode adapter contract tests, and end-to-end acceptance scenarios.
- Commit message format:

## Context discipline
- Long-output commands (test runs, builds, logs): pipe through `tail`/`head`, or redirect to a file and `grep` it. Never dump full output into the context window.
- Reading files: read only the section needed (`offset`/`limit`) after locating it with `grep`/`glob`, unless the whole file is genuinely required.

## Architecture
A single publishable package exposes a tool-neutral core, CLI, and OpenCode adapter. V1 owns a local SQLite store, human-approved lesson retrieval, privacy-bounded task evidence, and evidence-based model recommendations; the adapter translates OpenCode hooks and tools into core operations. Curated-document retrieval, phase-transition retrieval, and automatic model mutation are deferred until the two core value loops are validated. See [`docs/designs/2026-09-05-governed-memory-router-v1.md`](docs/designs/2026-09-05-governed-memory-router-v1.md).

`src/core` is grouped by domain (`db/`, `lessons/`, `documents/`, `tasks/`, `evidence/`, `models/`, `routing-replay/`, `backup/`); only cross-cutting singletons sit at its root alongside the `index.ts` barrel. Folder-growth rules live in `CLEANCODE.md` (Folder organization).

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

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->

<!-- opencode-swe-factory:lesson-capture-protocol@1 start -->
## Lesson Capture Protocol

A lesson is anything from this session about how to work that a future session should repeat or avoid: work that went well and should be repeated, or a mistake, correction, or expressed preference that should change how you work. Judge the substance, not the user's exact words.
Decisions about what to build — scope, requirements, product or architecture choices — are not lessons. Record those in the project's decision/design docs (e.g. docs/decisions.md, docs/designs/); writing them there is the terminal action, not a lesson proposal.
Bias toward proposing. Proposals are drafts awaiting human approval and expire if ignored, so a wasted proposal costs seconds while a missed lesson repeats the mistake. Recording a lesson in repo docs, a journal, or a summary does not substitute for proposing it.
When a lesson-worthy moment happens, propose it via the swe_factory_propose_lesson tool in the same turn, proactively — never wait to be asked. Never include secrets or credential-like content in a proposal.
Immediately after a proposal returns, present it for approval via the question tool (or your environment's equivalent interactive ask) with Approve / Edit / Defer / Reject options. Never just list the candidate in text.
<!-- opencode-swe-factory:lesson-capture-protocol@1 end -->
