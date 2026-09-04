# Decisions

Append-only log of architecture decisions. One entry per decision, newest at the bottom. Do not edit past entries; a reversed decision gets a new entry that supersedes the old one.

## 2026-09-03 — Record architecture decisions

**Status:** Accepted

**Context:** We need a lightweight way to record why significant technical decisions were made, so future work by any contributor, model, or tool does not rediscover or accidentally reverse them.

**Decision:** Keep architecture decisions in `docs/decisions.md`, one entry per decision, appended chronologically. A changed decision gets a new entry that supersedes the old one.

**Consequences:** Decisions and their reasoning survive context resets, model changes, tool switches, and contributor turnover.

## 2026-09-03 — Build a tool-neutral core with an OpenCode adapter

**Status:** Accepted

**Context:** The system must integrate deeply enough with OpenCode to observe tasks, inject relevant guidance, and select models, while keeping long-lived knowledge usable if the host coding tool changes.

**Decision:** Build a TypeScript/Bun core library and CLI with a publishable OpenCode plugin as the first and only V1 adapter. Use OpenCode's typed plugin hooks and SDK rather than a wrapper or fork. See the [coding memory and model router spec](specs/coding-memory-model-router.md).

**Consequences:** V1 fits OpenCode's native extension model and avoids fork maintenance. Core domain logic must remain separate from OpenCode-specific hooks, but additional coding-tool adapters remain out of scope.

## 2026-09-03 — Use local SQLite with federated project context

**Status:** Accepted

**Context:** The system must retain versioned lessons and performance evidence for a year or more without relying on an ever-growing Markdown file or creating duplicate authorities for existing project context.

**Decision:** Keep lessons, observations, indexes, and provenance in a plugin-owned SQLite database in the user's application-data directory. Index curated authoritative project files by reference using local-first hybrid lexical and semantic retrieval. See the [coding memory and model router spec](specs/coding-memory-model-router.md).

**Consequences:** The store supports migrations, indexing, project/global scope, backups, and cross-project personal memory. Existing context files remain authoritative, local embedding support is required, and database failure must not block OpenCode.

## 2026-09-03 — Route models from versioned execution evidence

**Status:** Accepted

**Context:** Model suitability varies by task, cost, latency, agent setup, tools, and model version. A single permanent model score would conceal these factors and become stale.

**Decision:** Route top-level requests and delegated subtasks among explicitly allowlisted models using versioned task and execution profiles. Track quality, reliability, cost, and latency separately, then apply a configurable quality-led weighted utility. Explicit model choices always win, and automatic routing begins only after sufficient evidence. See the [coding memory and model router spec](specs/coding-memory-model-router.md).

**Consequences:** The router requires structured task classification, outcome attribution, evidence decay, conservative cold-start behavior, controlled exploration, and transparent routing receipts. Thresholds and weights must be benchmarked before automation is trusted.
