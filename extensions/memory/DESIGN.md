# Pi Memory Extension — Design

## Problem

Pi's context is ephemeral. Every session starts fresh — the agent has no memory of project conventions, past architecture decisions, or team agreements. Developers paste "remember we use tabs" at the start of sessions or maintain CLAUDE.md files by hand. We want an automatic, plaintext memory system scoped to the project.

## Research

See [RESEARCH.md](RESEARCH.md).

## Principles

- **Plaintext storage** — NDJSON. Line-oriented, git-merge-friendly, easy to grep.
- **Content first** — In each JSON line, the `content` field is serialized first so PR diffs show the fact immediately.
- **No graphs** — No "supersedes", no complex relationships. CRUD only: add a line, remove a line.
- **Automatic by default** — Capture happens automatically. Minimal user interaction.
- **Manual override** — Users can trigger actions manually when needed.
- **Local speed** — Optimize for speed and usability on the local machine.
- **Embedded vectors** — Vector DB runs locally, stored in a gitignored directory.

## Why NDJSON

Each memory is one line:

```ndjson
{"content":"We use Zustand for state management","id":"abc123","created":"2026-05-01T14:30:00Z"}
```

**Git-friendly**: Adding appends a line. Removing deletes a line. Git diffs are clean.

**Grep-friendly**: `grep "Zustand" .pi/memory/practices.ndjson` works without parsing JSON.

**PR-friendly**: Each line is self-contained. Reviewers see the full fact in the diff.

## Format

The `content` field is always serialized first.

```typescript
interface MemoryLine {
  content: string;
  id: string;
  created: string;
}

function serializeMemory(obj: MemoryLine): string {
  const ordered = { content: obj.content };
  for (const [k, v] of Object.entries(obj)) {
    if (k !== 'content') ordered[k] = v;
  }
  return JSON.stringify(ordered);
}
```

## Categories

| Category | Definition | Sourceable by `memory_init`? |
|----------|-----------|------------------------------|
| **knowledge** | What the codebase *is* — frameworks, languages, dependencies | Yes |
| **practices** | How the codebase *works* — conventions, patterns, idioms | Yes |
| **decisions** | Why specific choices were made — tradeoffs, architecture rationale | No |

```
.pi/memory/
├── .gitignore
├── knowledge.ndjson     # Eager-loaded
├── practices.ndjson     # On-demand
└── decisions.ndjson     # On-demand
```

**`.pi/memory/.gitignore`**:
```gitignore
*.db
*.db-journal
```

## Architecture

### Implementation Notes

- **Source of truth stays NDJSON** in `.pi/memory/*.ndjson`.
- **`.pi/memory/vector.db` is a derived local index**, not the canonical memory store.
- Update and delete use **whole-file rewrite** for the affected category file.
- When no category filter is provided, `memory_recall` may return **both stored memories and indexed repo file hits**.
- `memory_list` is implemented as a small helper tool even though it is not part of the minimum design surface.

### Loading Strategy

Pi starts a fresh session with **<1K tokens**.

**Session start** (and after compaction):
1. Inject full contents of `knowledge.ndjson`
2. Inject a compact index of `practices.ndjson` + `decisions.ndjson`

**On-demand**: Agent calls `memory_recall` to retrieve full entries.

| | `knowledge.ndjson` | `practices.ndjson` + `decisions.ndjson` |
|--|-------------------|-----------------------------------------|
| **Loaded** | Eager | Lazy |
| **Volatility** | Low | Medium |
| **Size** | <50 lines typical | Grows with project |

## Tools

| Tool | Purpose |
|------|---------|
| `memory_remember` | Store a new memory. Requires `category` and `content`. |
| `memory_recall` | Retrieve memories by query. |
| `memory_forget` | Remove a memory by ID. |
| `memory_update` | Replace the content of an existing memory by ID. |
| `memory_learn` | Review recent activity and suggest NEW memories. Returns preview only. |
| `memory_consolidate` | Review stored memories and suggest cleanup. User-triggered, interactive. |
| `memory_init` | Scan codebase to seed `knowledge.ndjson` and `practices.ndjson`. User-triggered, idempotent. |

### Parameters

| Tool | Parameters | Returns |
|------|-----------|---------|
| `memory_remember` | `content`, `category` | `id` |
| `memory_recall` | `query`, `category?`, `limit?` | Matches |
| `memory_forget` | `id` | Confirmation |
| `memory_update` | `id`, `content` | Confirmation |
| `memory_learn` | `since?` | Preview |
| `memory_consolidate` | `since?` | Interactive report |
| `memory_init` | `force?` | Summary |

### `memory_recall` Behavior

1. Search vector DB via sqlite-vec
2. Fall back to FTS5 if vector DB unavailable
3. Return results ordered by relevance

## Vector Store

### Location

`.pi/memory/vector.db`

### Technology

| Component | Package |
|-----------|---------|
| Vector DB | `sqlite-vec` |
| Embeddings | `@huggingface/transformers` |
| Model | `onnx-community/all-MiniLM-L6-v2` (384 dims) |

### Fallbacks

1. sqlite-vec + embeddings (preferred)
2. SQLite FTS5 (keyword only)
3. grep/ripgrep (emergency)

### Rebuild

**On every write**: One embedding per line change. O(1), not O(n).

### Token Limit

Research needed: exact limit for the chosen model, whether truncation is sufficient, and alternatives with larger windows.

## Open Questions

1. `memory_recall` return format — index or full memories? Default `limit`?
2. `memory_learn` — How does it access recent activity?
3. `memory_consolidate` — What data does it review?
4. Embedding model — Max token limit and alternatives with larger windows
