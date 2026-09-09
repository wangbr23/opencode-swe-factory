# opencode-swe-factory

A local, privacy-bounded improvement layer for [OpenCode](https://opencode.ai): it turns your corrections into human-approved lessons that are retrieved in later sessions, and builds inspectable evidence for which models actually work on which kinds of tasks.

One package, three entry points:

- **Core** (`opencode-swe-factory/core`) — tool-neutral domain logic: lesson lifecycle, retrieval, task profiling, evidence aggregation, backup, and redaction. Never imports OpenCode types.
- **OpenCode adapter** (`opencode-swe-factory/opencode`, plugin entry `opencode-swe-factory/server`) — translates OpenCode plugin hooks and custom tools into core operations.
- **CLI** (`opencode-swe-factory/cli`) — configuration, inspection, correction, export, backup, restore, and diagnostics.

State lives in a single local SQLite database (WAL mode, foreign keys, owner-only permissions). There is no daemon, network service, hosted storage, or telemetry.

## What it does in V1

V1 proves two end-to-end loops ([design](docs/designs/2026-09-05-governed-memory-router-v1.md)):

1. **A human-approved correction is retrieved and applied to a similar task in a later session, without retaining the raw conversation.** When you explicitly correct the agent, praise a behavior, or state a lasting preference, the plugin proposes a structured draft (title, body, rationale, applicability, provenance, inferred scope). The draft is secret-scanned but cannot activate itself; you approve, edit, reject, or defer it through a question card. Only approved lessons become durable. At the start of later tasks, matching lessons are retrieved (SQLite FTS5 lexical + optional local semantic retrieval), conflicting directives are suppressed rather than silently chosen between, and results are packed into the primary system block under a fixed token budget with a compact receipt.

2. **Privacy-bounded execution evidence changes a model recommendation for a compatible task, with the evidence inspectable.** Task profiles (activity, domain, complexity, stack, risk) and outcome signals (assistant completions, derived tool success/failure, explicit feedback) are stored in redacted form — never raw prompts, responses, or tool output. Decayed evidence per model/variant and task profile produces a recommendation with its reasoning. V1 is **recommendation-only**: the model you select stays authoritative; the plugin never mutates it.

What V1 deliberately excludes: transcript/session-history capture, raw prompt/response/tool-output retention, automatic model mutation, routing overrides, and exploration. See the design docs for the full boundary.

## Installation

Requirements: [Bun](https://bun.sh) and OpenCode 1.18.27 or newer.

1. Install the package:

   ```sh
   bun install
   bun run build
   ```

2. Register the plugin with OpenCode in `~/.config/opencode/opencode.json` (global) or `<project>/.opencode/opencode.json` (per project):

   ```json
   {
     "plugin": ["file:///absolute/path/to/opencode-swe-factory"]
   }
   ```

   The plugin resolves through the package's `exports["./server"]` entry, so a published npm install would use `"plugin": ["opencode-swe-factory"]` instead.

3. Optional, for semantic retrieval: download and verify the pinned embedding artifacts (`Xenova/all-MiniLM-L6-v2`):

   ```sh
   bun run src/cli/index.ts embeddings-install
   ```

   Without them, lexical retrieval still works. Check readiness anytime with `embeddings-status`.

On the next session start, the plugin validates configuration, opens and migrates the database, writes a `plugin-init/compatibility` diagnostic, and installs a lesson-proposal protocol block into the project's `AGENTS.md` (fail-open; installation problems never block a session).

### OpenCode version compatibility

- **Below 1.18.27** or an unresolvable version probe: context injection and model recommendation are disabled; CLI and memory tools keep working. The reason is recorded in diagnostics (`status` command).
- **At or above the minimum**: injection is enabled. Versions in the tested manifest run clean; newer untested versions run with a warning diagnostic instead of being disabled, so an OpenCode update never silently stops lesson retrieval.

## Data locations

Resolved per OS (`src/core/paths.ts`), overridable with `OPENCODE_SWE_FACTORY_DATA_DIR`:

| Platform | Config | Data | Cache |
| --- | --- | --- | --- |
| macOS | `~/Library/Application Support/opencode-swe-factory/` | `.../opencode-swe-factory/data/` | `~/Library/Caches/opencode-swe-factory/cache/` |
| Linux | `~/.config/opencode-swe-factory/` | `~/.local/share/opencode-swe-factory/data/` | `~/.cache/opencode-swe-factory/cache/` |
| Windows | `%APPDATA%\opencode-swe-factory\` | `%APPDATA%\opencode-swe-factory\data\` | `%LOCALAPPDATA%\opencode-swe-factory\cache\` |

The data directory holds `memory.sqlite` (the store), `diagnostics.jsonl` (observability), and `backups/`. All files get owner-only permissions.

## Controls

Feature toggles — `retrieval`, `recording`, `modelTelemetry`, and `routing` — are independently controllable at global, project, and session scope. **Private mode resolves all four to disabled before any task text reaches the core.** The package configuration file (`config.json` in the config directory above; CLI-managed, separate from OpenCode's config) covers routing mode and preset, the model/variant allowlist, hard cost/latency limits, embedding artifact location, backup schedule and retention, maintenance thresholds, and the toggles.

```sh
bun run src/cli/index.ts config                    # show current configuration
bun run src/cli/index.ts config set <path> <value> # e.g. config set privateMode.enabled true
bun run src/cli/index.ts toggles                   # resolved toggles per scope
```

## Privacy boundaries

- **Never persisted:** raw prompts, assistant responses, tool outputs, transcripts, or raw classifier input. Task records hold structured classifications and redacted summaries only.
- **Pending lesson candidates** are structured drafts excluded from retrieval; they expire automatically and are deleted on rejection.
- **Secret admission control:** a maintained secret-scanning library (secretlint) plus conservative credential-pattern and entropy checks run before lesson text, task summaries, diagnostics, or exports are persisted. High-confidence live credential values are hard-blocked; lower-confidence matches require an explicit `--acknowledge-secret-risk` recorded in provenance.
- **Diagnostics** store redacted paths and summaries only.
- **Hard deletion** (`hard-delete`) removes all stored data, FTS entries, embeddings, pending candidates, derived evidence, and managed backups, then checkpoints, vacuums, and creates a clean baseline. It cannot retract user-copied exports or guarantee physical erasure from SSD snapshots.

## Network behavior

Normal operation is fully local: retrieval, profiling, evidence, and recommendations run against the local SQLite store. The one intentional network touchpoint is `embeddings-install`, which downloads the pinned embedding model artifacts with checksum verification and never runs by itself — private mode never initiates downloads, and remote model loading is disabled during normal inference (`embeddings.allowRemoteDownloads: false` by default). If the embedding model is missing or fails, lexical retrieval proceeds immediately.

## CLI

Run commands as `bun run src/cli/index.ts <command>` (or the installed `opencode-swe-factory` binary). Global options: `--database`, `--backup-dir`, `--config`, `--project`.

| Command | Purpose |
| --- | --- |
| `backup` / `backup-status` | Create a managed snapshot now; show schedule, retention, and snapshots |
| `config`, `config get/set <path> <value>` | Read and manage the package configuration |
| `toggles` | Show resolved feature toggles per scope |
| `review [id]` | List pending lesson candidates; review one with overlap analysis |
| `search <query>` / `lesson <id>` | Search confirmed lessons; inspect one |
| `supersede <id> --title/--body/--rationale` | Replace a lesson's active version (new immutable version) |
| `task <id>` / `task <id> --activity/--domain/...` | Inspect or correct a task's active profile |
| `feedback <task-id> --kind acceptance/correction/rework` | Record explicit high-confidence quality feedback |
| `evidence <task-id>` | Inspect recorded evidence signals for a task |
| `relink <project-id> --path/--remote` | Change a project's path or remote association |
| `export <path>` / `restore <path>` | Export schema-versioned JSONL; restore into a validated copy before swap |
| `hard-delete` | Permanently delete all stored data and managed backups |
| `status` | Diagnostics, managed paths, compatibility state |
| `embeddings-install` / `embeddings-status` | Manage pinned local embedding artifacts |

## Recovery

- **Backups** are SQLite-consistent snapshots with integrity checks, versioned retention, and atomic rename (`backup`, `backup-status`; schedule via `config set backups.*`).
- **Corruption or migration failure** leaves the original database untouched and OpenCode runs fail-open (ordinary behavior, visible diagnostic); unknown newer schemas refuse writes but keep a safe diagnostic/export path.
- **Restore** is transactional into a new database, validated there, and swapped in only after integrity checks pass.
- **Export** includes schema version, relationships, provenance, and tombstones so supersession history survives.

## Development

```sh
bun install          # dependencies
bun test             # unit, contract, and acceptance suites
bun run typecheck    # tsc --noEmit
bun run build        # tsc -p tsconfig.build.json
bun run benchmark:retrieval
bun run benchmark:routing
```

Source layout: `src/core/` grouped by domain (`db/`, `lessons/`, `documents/`, `tasks/`, `evidence/`, `models/`, `routing-replay/`, `backup/`), `src/opencode/` for the adapter, `src/cli/` for the CLI, `src/types/` for shared types. `AGENTS.md` describes repo conventions; design documents live in `docs/designs/`.