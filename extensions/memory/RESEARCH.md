# Pi Memory Extension — Research

## Systems Analyzed

### 1. opencode-plugin-simple-memory
**Source**: https://github.com/cnicolov/opencode-plugin-simple-memory

**Architecture**: Plain-text logfmt files in `.opencode/memory/`. Daily log rotation. No external dependencies.

**Tools**: `memory_remember`, `memory_recall`, `memory_update`, `memory_forget`, `memory_list`

**Types**: `decision`, `learning`, `preference`, `blocker`, `context`, `pattern`

**Scope**: Single user. No global/local split.

**What works**: Simple file I/O is fast and inspectable. Types force structure without over-engineering.

**What fails**:
- No semantic search — retrieval is exact-match or type-filtered only
- No memory management (accumulates forever, no decay, no consolidation)
- No reflection loop — memories are raw observations, never distilled into patterns
- No temporal awareness — can't answer "what did we do last Monday?"
- Memory blindness: with 100 memories, only a few get surfaced per prompt

**Core insight**: Implements "write" and "read" but neglects "manage."

---

### 2. Letta / MemGPT
**Source**: https://www.letta.com/blog/agent-memory, https://github.com/letta-ai/letta
**Papers**: arXiv:2310.08560

**Architecture**: OS-inspired virtual memory. Core Memory Blocks (RAM) + External Memory (disk). Agents actively manage their own memory via built-in tools.

**Key finding**: Plain filesystem scores **74%** on LoCoMo benchmark — beating specialized vector-store libraries. The 26% gap may not matter for personal use.

**What works**: Self-managing agents are powerful. Skill learning from experience (memory transferable across models).

**What fails**: Complex paging logic is hard to debug. Silent orchestration failures (wrong thing evicted, no error thrown).

**Core insight**: Simple storage formats are surprisingly effective. The complexity is in management, not storage.

---

### 3. Claude Diary (by Lance Martin, LangChain)
**Source**: https://rlancemartin.github.io/2025/12/01/claude_diary/

**Architecture**: Three components inspired by Generative Agents paper:
1. **Observations** — raw diary entries from sessions
2. **Reflection** — `/reflect` command analyzes multiple diaries for patterns
3. **Retrieval** — loads CLAUDE.md with distilled rules

**Pattern thresholds**: 2+ occurrences = pattern, 3+ = strong pattern.

**What works**: Structured diary extraction. Pattern detection across sessions. Reflection is manual (human reviews before writing to CLAUDE.md).

**What fails**: Manual `/reflect` step requires user initiative. No automatic consolidation.

**Core insight**: Reflection should be manual when it writes to committed files — bad learnings need human review.

---

### 4. claude-mem
**Source**: https://github.com/thedotmack/claude-mem

**Architecture**: SQLite + FTS5 + ChromaDB. Express server on port 37777. Web UI.

**Lifecycle hooks**: SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd.

**Progressive disclosure**: 3-layer retrieval — search index (~50-100 tokens) → timeline view → detailed fetch (~500-1000 tokens). ~10x token savings.

**Tools**: 5 MCP tools — search, timeline, get_observations, save_memory, __IMPORTANT.

**Cost**: ~$3-50/month for personal use at 100 queries/day.

**What works**: Full-text + vector hybrid. Progressive disclosure saves tokens. Lifecycle hooks automate capture.

**What fails**: Single-user design. Not project-focused. ChromaDB adds weight.

**Core insight**: Progressive retrieval (cheap → expensive) is key for token efficiency.

---

### 5. memU (by NevaMind-AI)
**Source**: https://github.com/NevaMind-AI/memU

**Architecture**: Three-layer hierarchy:
- **Resource** (mount point) — Raw conversations, documents, files
- **Memory Item** (file) — Extracted facts, preferences, skills
- **Memory Category** (folder) — Auto-organized topics with summaries

**Filesystem metaphor**: Categories = folders, Items = files, Cross-references = symlinks, Mount points = resources.

**Dual retrieval**:
- RAG (fast): embedding search for real-time context
- LLM-based (deep): reads files directly for anticipatory reasoning

**Proactive agent**: Separate "memU Bot" monitors, memorizes, predicts intent, pre-fetches context. 24/7 background process.

**Benchmark**: 92.09% on LoCoMo.

**Infrastructure**: Temporal workflows + PostgreSQL + pgvector. Python-based.

**What works**: Hierarchical organization. Cross-references. Auto-categorization. Full traceability (resource → item → category).

**What fails**: Heavy infrastructure (Temporal, PostgreSQL, workers). 24/7 proactive agent is overkill for coding workflows. Not git-friendly.

**Core insight**: Filesystem metaphor is LLM-native. Categories scale where flat files don't. Cross-references build implicit knowledge graphs without graph databases.

---

### 6. Claude Code (Anthropic)
**Source**: https://code.claude.com/docs/en/memory

**Architecture**: Hierarchical markdown files (`CLAUDE.md`) read recursively from cwd. Lazy-loaded by subdirectory. `.claude/rules/` for scoped rules. `/memory` command shows loaded files.

**Official Memory Tool** (Beta): File-based CRUD in `/memories` directory via tool calls.

**Performance**: 39% improvement on agentic search when combining memory with context editing. 84% token reduction in 100-turn evaluations.

**Known issue**: ~53K tokens loaded before first user message.

**What works**: Markdown is LLM-native. Hierarchical loading respects project structure. Lazy loading saves tokens.

**What fails**: No automatic capture — user must manually maintain CLAUDE.md. No consolidation from session history.

**Core insight**: Hierarchical markdown files are the right format. The problem is manual maintenance.

---

### 7. fsck.com Episodic Memory (by Jesse Vincent)
**Source**: https://blog.fsck.com/2025/10/23/episodic-memory/

**Architecture**: Archives all conversations from `~/.claude/projects` into SQLite with vector search. Haiku subagent manages context bloat.

**What works**: Complete conversation archive. Haiku subagent is cheap for context compression. MCP integration gives Claude access to its own history.

**What fails**: SQLite is not git-friendly. Requires MCP setup.

---

## Academic Foundations

### Key Papers

| Paper | Date | Contribution |
|-------|------|------------|
| "Memory in the Age of AI Agents: A Survey" (arXiv:2512.13564) | Dec 2025 | Four memory types: factual, experiential, working. Write-manage-read framework. |
| "Rethinking Memory in LLM-based Agents" (arXiv:2505.00675) | May 2025 | Six operations: Consolidation, Updating, Indexing, Forgetting, Retrieval, Condensation. |
| Generative Agents (arXiv:2304.03442, UIST 2023) | Apr 2023 | Observation + Reflection + Planning architecture. Smallville simulation. |
| Reflexion (arXiv:2303.11366, NeurIPS 2023) | Mar 2023 | Verbal reinforcement learning. Actor + Evaluator + Self-Reflection model. |
| Mem0 paper (arXiv:2504.19413) | Apr 2025 | Two-phase pipeline (Extraction + Update). Graph-based memory. |
| Zep architecture (arXiv:2501.13956) | Jan 2025 | Temporal knowledge graphs. Bi-temporal model. 94.8% on DMR. |

### The Write-Manage-Read Loop

From arXiv:2512.13564 and practitioner reports:

- **Write**: New information enters memory (observations, results, reflections)
- **Manage**: Compression, pruning, consolidation, contradiction resolution
- **Read**: Relevant memory retrieved and injected into context

Most implementations nail write and read, neglect manage. Result: noise accumulation, contradictions, stale data.

### Four Temporal Scopes

1. **Working Memory** — Context window. Ephemeral, limited. Failure: "lost in the middle" effect.
2. **Episodic Memory** — Time-stamped experiences. Enables case-based reasoning.
3. **Semantic Memory** — Distilled facts, heuristics, preferences. Must be curated.
4. **Procedural Memory** — Encoded skills, behavioral patterns, learned workflows.

### Key Failure Modes

| Failure | Description | Example |
|---------|-------------|---------|
| Summarization drift | Repeated compression loses fidelity. After 5 summaries, memory barely resembles reality. | Claude Code long sessions degrading |
| Semantic vs causal mismatch | Embeddings find similar text but miss cause/effect. | Debugging: agent sees similar errors but misses root cause |
| Memory blindness | Important fact never resurfaces because retrieval limit is too low. | The 11th memory you need is never retrieved |
| Silent orchestration | Paging/eviction does wrong thing, no error thrown. | MemGPT evicting wrong memory block |
| Staleness | Outside world changes, memory doesn't. | "We use Redux" but migrated to Zustand 3 weeks ago |
| Self-reinforcing errors | Bad memory treated as ground truth forever. | Agent decides SmartThings integration is faulty, ignores all future data from it |
| Contradictions | New info conflicts with old, agent can't resolve. | "Workflow exists" vs "workflow failed" oscillation |

### Cost Benchmarks

Per-query for personal agent (~100 queries/day):

| Component | Cost/Query | Monthly |
|-----------|-----------|---------|
| Intent recognition (Haiku) | ~$0.00025 | ~$0.75 |
| Embedding generation | ~$0.000004 | ~$0.01 |
| Vector search (self-hosted) | $0 | $0 |
| Re-ranking (optional) | ~$0.002 | ~$6 |
| Context assembly (Sonnet) | ~$0.014 | ~$42 |
| **Total** | **~$0.016** | **~$48** |

Without re-ranking, using cheaper models: **~$3/month**.

Key finding from Mem0: purpose-built memory layers cut token costs by ~90% and reduce latency by ~91% vs full conversation history.

### The 74% Filesystem Benchmark

Letta found a plain filesystem (just storing conversation histories in files) scores **74%** on LoCoMo benchmark — beating specialized memory libraries.

Implication: The storage format matters less than expected. Retrieval and management matter more.

---

## What Other Coding Agents Do

| Tool | Memory Approach | Cross-Session? | Notes |
|------|-----------------|---------------|-------|
| Claude Code | `CLAUDE.md` files | Yes | Hierarchical, lazy-loaded. Manual maintenance. |
| Cursor | `.cursor/commands/*.md` + rules | Partial | No built-in cross-session memory yet. |
| Cline | `.clinerules` | No | Project standards only. |
| Windsurf | "Memories & Rules" layer | Yes | "Occasionally clings to outdated patterns after major refactors" |
| GitHub Copilot | Chat history only | No | Per-session context. |

---

## Synthesis: What Works for Coding Agents

1. **Markdown files are the right storage format** — LLM-native, human-readable, git-friendly. Letta proved 74% effectiveness with plain files.

2. **Hierarchical organization beats flat** — Categories as folders scale where single files don't. memU's filesystem metaphor is validated.

3. **Auto-capture raw episodes, tool-call consolidation** — Raw sessions are noise. Committed files are signal. Agent writes noise, intent produces signal.

4. **Cross-references without graph databases** — Frontmatter `related` fields give 80% of graph value with 0% of graph complexity.

5. **Progressive retrieval saves tokens** — Cheap keyword search first, expensive semantic/deep read only when needed.

6. **Local embeddings only** — Avoids API costs, privacy issues, external dependencies. Accept trade-off of slower indexing.

7. **Global + local scopes** — User preferences span projects. Architecture decisions are project-specific. Both need representation.

8. **Consolidation needs human review** — When writing to committed files, human PR review prevents bad learnings from poisoning the knowledge base.

9. **No background processes** — Pi extension lifecycle only. Session starts, session ends. No Temporal, no PostgreSQL, no daemons.

---

*Last updated: 2026-05-01*
