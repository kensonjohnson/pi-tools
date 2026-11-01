# Project Memory design

Project Memory keeps durable project context in plaintext and injects a briefing into Pi sessions. [RESEARCH.md](RESEARCH.md) records earlier research; this document describes the current workflow.

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

The files can be inspected and edited directly. IDs remain stable through updates and category moves. NDJSON is not a provenance graph: a record does not necessarily identify its original instruction or evidence.

`memory_init` creates the store and index and can optionally seed basic project facts. Initialization preserves malformed lines. Ordinary mutations reject malformed records or ambiguous duplicate IDs. Foreground review does not silently repair either. Inspect the files and resolve duplicate IDs explicitly. `memory_repair` is the explicit recovery path for removing malformed non-empty lines; review the source files before running it.

Cooperating processes serialize canonical operations with a project-wide SQLite lock. Changes use checked snapshots and atomic file replacement. Category moves use a private transaction journal so interrupted moves can be recovered when snapshots still match; ambiguous changes fail closed. Manual editors do not take the lock, and an edit between the final check and rename can still race a replacement. Private runtime files and derived databases are Git-ignored.

## Briefing and recall

On a new session, the extension injects all knowledge entries and guidance to use `memory_recall` for relevant practices and decisions. After compaction it injects a fresh briefing on the next agent turn. Ordinary turns do not refresh the existing briefing, even if the files change. An empty knowledge category produces no briefing. There is no fixed knowledge token limit; keeping the briefing useful and appropriately sized is a maintenance task.

`.pi/memory/vector.db` is a derived SQLite index, not the source of truth. The manager reconciles it with current NDJSON snapshots before recall. Semantic search uses `sqlite-vec` and a local embedding model when available; FTS5 and literal matching provide fallbacks. The embedding model may need to be downloaded on first use. A forced rebuild updates the live index rather than deleting its database file.

## Foreground consolidation

The operator can request a review with `/memory-review` when the agent is idle. The `memory_consolidate` tool provides the same foreground instructions when the user explicitly requests consolidation. The project must be trusted and its memory store initialized and enabled.

The current agent conducts the review visibly with its normal model and tools. It inspects the memory categories and available repository and relevant session-history evidence, considers stale facts and overlaps, and applies only supported changes. It reports changes, evidence gaps, conflicts, and uncertainty. A directly verified missing file or path is evidence that a memory claiming it exists is stale; it does not prove unrelated claims. Explicit user instructions should not be silently overridden by conflicting repository evidence; a later explicit instruction may supersede an earlier one. Evidence and model judgments are not guarantees of correctness. Inspect the uncommitted NDJSON diff.

During foreground review, `memory_update` and `memory_forget` require the exact reviewed `expectedContent`. When removing a duplicate, the agent also supplies the retained record's ID and exact reviewed content. A mismatch fails the operation; the agent must inspect the records and evidence again before deciding. Checked snapshots guard the write after that comparison. Pi's `write` and `edit` tools are blocked from directly changing the canonical memory files during review, including recognized symlink and hard-link aliases.

This guard is not an OS sandbox. The foreground agent remains trusted: bash and other tools can bypass it, and path checks can race filesystem changes. Review the Git diff before committing. Memory's locks coordinate cooperating writers, not concurrent manual editors; their changes can still race the final replacement.

There is no automatic session-history review, background review model dispatch, or activity queue. Foreground consolidation uses the current session. Project session messages, memories, and repository excerpts inspected during a review can be sent to that session's model provider. They may contain sensitive data; check the provider's privacy and retention policy.

## Tools

| Tool                 | Purpose                                                                             |
| -------------------- | ----------------------------------------------------------------------------------- |
| `memory_init`        | Initialize the store and index; optionally seed memories or force an index rebuild. |
| `memory_remember`    | Add a memory in a category.                                                         |
| `memory_recall`      | Search memories, optionally filtering by category and limiting results.             |
| `memory_list`        | List stored memories and category counts.                                           |
| `memory_update`      | Replace a memory's content by ID; optionally check `expectedContent`.               |
| `memory_forget`      | Remove a memory by ID; optionally check `expectedContent`.                          |
| `memory_repair`      | Explicitly remove malformed non-empty lines and resync the index.                   |
| `memory_consolidate` | Start a foreground review on explicit request.                                      |
