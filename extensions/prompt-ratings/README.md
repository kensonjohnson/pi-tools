# Prompt Ratings Extension (Planned)

This directory is reserved for a future implementation of a prompt ratings extension.

## Goals

- Capture every assistant message with its prompt context, model, and response.
- Provide upvote / downvote / skip ratings so we can build a feedback loop.
- Search historical prompts and responses by text or semantic similarity.
- Show per-model rating statistics.
- Keep all data local (no API keys for ratings).
- Be robust against session reloads, restarts, and concurrent use.

## Known issues in the previous implementation

1. **Database lifecycle bug**: `better-sqlite3` opened the connection in the constructor, then `session_shutdown` closed it. On the next session `ensureDb()` only checked a boolean and skipped re-opening the underlying connection, causing random `The database connection is not open` errors during `insertInteraction`.
2. **No connection retry / recovery**: once the DB closed, the extension stayed broken until pi was restarted.
3. **Heavy local embedding startup**: `@huggingface/transformers` with ONNX embedding added noticeable cold-start overhead on every session and complicated the dependency tree.
4. **Noisy widget**: it updated on every assistant message even when the user never rated anything.
5. **Auto-capture by default**: every interaction was recorded automatically; some users may prefer opt-in or a sampling mode.

## Desired design

### Database

- Keep a single global SQLite database in `~/.pi/agent/ratings.db`.
- Open the connection lazily on first use, not in the module constructor.
- Close it only in `session_shutdown` and reopen lazily on the next operation.
- Make `initialize()` re-entrant and actually reopen the connection each time if needed.
- Store plain text in an `interactions` table plus an FTS5 index.
- Make semantic/vector search optional: if `sqlite-vec` and a small local embedding model are available, enable it; otherwise fall back to FTS only.

### Capture

- Record on `message_end` when the role is `assistant` and we have a pending prompt from `before_agent_start`.
- Include `sessionFile`, `entryId`, `cwd`, prompt text, response text, model provider/id/name, and an initial rating of `0` (unrated).
- Wrap the insert in a try/catch and silently degrade (no widget) if the DB is unavailable; never throw into the extension runner.

### Ratings

Commands:
- `/u` — upvote the latest unrated response (rating `1`).
- `/d` — downvote the latest unrated response (rating `-1`).
- `/s` — skip/neutral the latest unrated response (rating `0`).
- `/rate_search <query>` — full-text search over prompts/responses.
- `/votestats [provider?]` — per-model leaderboard.

Shortcuts (TUI only):
- `Ctrl+Shift+U` — upvote
- `Ctrl+Shift+D` — downvote
- `Ctrl+Shift+S` — skip

### Widget

- Show only when there is a latest unrated interaction and the UI is available.
- Clear the widget as soon as the user rates or sends a new message.

### Search

- Use FTS5 by default.
- If semantic search is enabled, blend semantic + FTS results with a simple reciprocal-rank fusion or score-based merge.
- Allow filters: `prompt`, `response`, `both`, rating range, model/provider, date range.

### Statistics

- Aggregate upvotes, downvotes, skips, and totals by model/provider.
- Compute upvote/downvote ratio and upvote percentage.
- Allow optional provider filter.

## Open questions

- Should ratings be opt-in via a flag, or always capture but only show the widget when explicitly enabled?
- Should embeddings be bundled in this package or moved to a separate `pi-tools` utility so other extensions can share them?
- Do we want to export a tool (`rate_search`, `rate_stats`) that the LLM can call, or keep it command-only?
- Should there be a way to delete or export the ratings database from a command?

## Dependencies to consider

- `better-sqlite3`
- `sqlite-vec` (optional)
- A lightweight local embedding provider (optional; maybe reuse the same one used by the memory extension)

## Status

Not yet implemented. This README defines the target behavior for a future rewrite.
