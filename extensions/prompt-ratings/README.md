# Prompt Ratings Extension

A pi extension that captures every assistant message, embeds prompts and responses locally with sqlite-vec, and provides upvote/downvote/skip ratings. Includes semantic search over your prompt history and a per-model statistics dashboard.

## Features

- **Auto-capture**: Every assistant message is automatically saved with prompt, response, and model info
- **Local embeddings**: 100% local — no API keys. Uses `@huggingface/transformers` with `all-MiniLM-L6-v2-ONNX` (384-dim)
- **Ratings**: Rate each response after it streams
  - `/u` or `Ctrl+Shift+U` — upvote
  - `/d` or `Ctrl+Shift+D` — downvote
  - `/s` or `Ctrl+Shift+S` — skip (neutral)
- **Widget**: Non-blocking widget above the editor shows the latest unrated response
- **Search**: `rate_search` tool — semantic + full-text search over prompts/responses with ratings
- **Stats**: `rate_stats` tool — per-model leaderboard ranked by upvote percentage
- **Dashboard**: `/votestats` command — formatted table of all model ratings

## Installation

1. Copy this directory to your pi extensions location:
   ```bash
   mkdir -p ~/.pi/agent/extensions/prompt-ratings
   cp -r extensions/prompt-ratings/* ~/.pi/agent/extensions/prompt-ratings/
   cd ~/.pi/agent/extensions/prompt-ratings
   npm install
   ```

2. Reload pi or start a new session. The extension auto-loads from `~/.pi/agent/extensions/`.

## Database

Global SQLite database at `~/.pi/agent/ratings.db` with:
- `interactions` table — one row per assistant message
- `interaction_fts` — FTS5 for text fallback search
- `prompt_vectors` / `response_vectors` — sqlite-vec for semantic similarity

## Commands

| Command | Description |
|---------|-------------|
| `/u` | Upvote latest unrated response |
| `/d` | Downvote latest unrated response |
| `/s` | Skip latest unrated response |
| `/votestats [provider?]` | Show model rating dashboard |

## Tools

| Tool | Description |
|------|-------------|
| `rate_search` | Semantic + FTS search over prompt/response history |
| `rate_stats` | Per-model upvote/downvote statistics |
| `rate_last` | Manually rate the most recent response |

## Rating Scale

- `1` = upvote
- `0` = skip/neutral (default)
- `-1` = downvote

## Dependencies

- `better-sqlite3`
- `sqlite-vec`
- `@huggingface/transformers`
