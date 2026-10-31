# Project Memory design

Project Memory keeps durable project context in plaintext and injects a briefing into Pi sessions. [RESEARCH.md](RESEARCH.md) records the earlier research; this document describes the current implementation.

## Storage and categories

The source of truth is three NDJSON files under `.pi/memory/`. Each non-empty valid line contains a memory ID, content, creation timestamp, and optional update timestamp. Newly serialized records put `content` first for readable diffs.

```ndjson
{"content":"The project uses Zustand for state management.","id":"abc123","created":"2026-05-01T14:30:00Z"}
```

| File               | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `knowledge.ndjson` | What the project is. Its contents form the session briefing.  |
| `practices.ndjson` | Conventions and ways of working, recalled on demand.          |
| `decisions.ndjson` | Architecture choices and their rationale, recalled on demand. |

The files can be inspected and edited directly. IDs remain stable through updates and category moves. NDJSON is not a provenance graph: a record does not necessarily identify its original instruction or evidence. The reviewer must therefore treat uncertain authority conservatively.

`memory_init` creates the store and index and can optionally seed basic project facts. Initialization does not silently remove malformed lines. Ordinary mutations reject malformed records or duplicate IDs. Full and background reviews resolve duplicate IDs by retaining the first ID and assigning fresh IDs to later records, preserving their content. `memory_repair` is the explicit recovery path for removing malformed non-empty lines. Review the source files before running a destructive repair.

Cooperating processes serialize canonical operations with a project-wide SQLite lock. Changes use checked snapshots and atomic file replacement. Category moves use a private transaction journal so interrupted moves can be recovered when their snapshots still match; ambiguous changes fail closed. Uncooperative editors do not take the lock, and an edit between the final check and rename can still race a replacement. Private runtime files and the derived databases are Git-ignored.

## Briefing and recall

On a new session, the extension injects all knowledge entries and guidance to use `memory_recall` for relevant practices and decisions. After compaction it injects a fresh briefing on the next agent turn. Ordinary turns do not refresh the existing briefing, even if the files change. An empty knowledge category produces no briefing. There is no fixed knowledge token limit; keeping the briefing useful and appropriately sized is a maintenance task.

`.pi/memory/vector.db` is a derived SQLite index, not the source of truth. The manager reconciles it with current NDJSON snapshots before recall. Semantic search uses `sqlite-vec` and a local embedding model when available; FTS5 and literal matching provide fallbacks. The embedding model may need to be downloaded on first use. A forced rebuild updates the live index rather than deleting its database file.

## Automatic review

Automatic review requires a trusted project, an existing initialized memory store, session-history review enabled, and an explicitly configured reviewer model. In `/pi-tools`, **Project Memory → Memory reviewer model** sets `models.reviewer` to `provider/model`. The default is empty, which disables review. The reviewer does not fall back to the foreground model.

`historyReview.enabled` defaults to `true`; setting it to `false` disables background session-history review. `historyReview.debounceSeconds` defaults to 30 and `historyReview.cooldownSeconds` to 300. Settled session activity schedules bounded review in the background. The project-wide scheduler coordinates cooperating sessions and retains pending work across restarts. Interrupted or uncertain work can require explicit attention rather than automatic replay.

**Privacy:** review can send project session messages, existing memories, and selected repository excerpts to the configured model provider. They may contain sensitive project or personal data. Model and provider policies determine external retention and processing; check them before configuring a reviewer. Local runtime state is stored under `.pi/memory/.runtime/` and is not intended for source control.

Read-only snapshots acquire the cooperative SQLite write lock and may create the private coordination database `.pi/memory/write-lock.db` if it does not exist. They do not initialize, repair, or rewrite canonical NDJSON files. Cancellation is forwarded while waiting for the lock. The lock coordinates participating memory writers, not manual editors.

The reviewer uses active session branches and eligible forked sessions, along with read-only project evidence. It sizes requests using the selected model's advertised context and output capacity, and continues through memory, session, and evidence chunks instead of imposing a fixed item count. It does not set its own model output-token limit; provider limits still apply. An explicit context-overflow response causes a smaller inference retry before any write. It can propose additions, updates, removals, and category moves. Host-side checks validate source receipts, memory snapshots, and write preconditions before application. Explicit user instructions are protected against contradictory repository evidence; a demonstrably later explicit instruction can supersede them. Conflicts or uncertain authority remain unresolved instead of being guessed away. A model's assessment and a matching citation are not proof that a proposal is correct. Review the resulting NDJSON diffs.

Ephemeral sessions, inaccessible or malformed sources, unsupported session content, and unverifiable fork history may be excluded or left pending. Large session files are currently parsed in memory, so transient memory use grows with file size. Session text and repository files are untrusted data, not instructions to the reviewer. Concurrent external edits can still race the final checks, and an operation interrupted during application may have an uncertain outcome.

## Review controls

`/memory-review` and `/memory-review status` show a bounded report with pending work, recent outcomes, and changes. Change counts identify details omitted from the bounded report. `/memory-review full` starts or continues a manual full review; `/memory-review cancel` requests cancellation and pauses pending work; `/memory-review resume` explicitly resumes it. Unresolved assessments remain in the report and do not pause reviews; `/memory-review full` can retry them, though the conflict may remain. Background review leaves the affected generation pending until new activity or explicit resume. Inspect uncertain outcomes before resuming. Cancellation may not stop work already in progress, including work owned by another process. If another review holds the project claim, wait for it to finish before retrying. Temporary status feedback does not require opening a screen; reports remain available after it clears.

Full-review progress is saved between bounded passes and tied to the memory snapshot. Run `/memory-review full` again to continue, or `/memory-review full --restart` to discard the saved cursor and start from the beginning. If the snapshot has changed, restart the review rather than continuing the stale cursor. The `memory_review` tool exposes `status`, `full`, `cancel`, and `resume` for agent and headless use; `restart: true` on its `full` action starts over. Manual and background reviews share the project claim and the same evidence and application path. Manual full review requires a trusted project, an initialized enabled memory store, and an explicitly configured reviewer model. It remains available when session-history review is disabled, but can still send existing memories and selected repository excerpts to the configured provider and may apply changes.

## Tools

| Tool                 | Purpose                                                                             |
| -------------------- | ----------------------------------------------------------------------------------- |
| `memory_init`        | Initialize the store and index; optionally seed memories or force an index rebuild. |
| `memory_remember`    | Add a memory in a category.                                                         |
| `memory_recall`      | Search memories, optionally filtering by category and limiting results.             |
| `memory_list`        | List stored memories and category counts.                                           |
| `memory_update`      | Replace a memory's content by ID.                                                   |
| `memory_forget`      | Remove a memory by ID.                                                              |
| `memory_repair`      | Explicitly remove malformed non-empty lines and resync the index.                   |
| `memory_learn`       | Preview suggestions from recent activity; it does not apply them.                   |
| `memory_review`      | Inspect review status and reports, run a full review, or cancel or resume work.     |
| `memory_consolidate` | Run a model-based full review that may apply memory changes.                        |

`memory_consolidate` previously returned duplicate suggestions. It now runs the same potentially mutating full review as `memory_review` with action `full`; its legacy `since` option is rejected. `memory_learn` remains suggestion-only.
