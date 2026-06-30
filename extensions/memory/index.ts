import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  MemoryManager,
} from "./core.ts";

const managers = new Map<string, Promise<MemoryManager>>();

function isMemoryCategory(value: string | undefined): value is MemoryCategory {
  return value !== undefined && MEMORY_CATEGORIES.includes(value as MemoryCategory);
}

async function getManager(cwd: string): Promise<MemoryManager> {
  const existing = managers.get(cwd);
  if (existing) {
    return existing;
  }

  const created = Promise.resolve(new MemoryManager(cwd));
  managers.set(cwd, created);
  return created;
}

const NOT_ENABLED_MESSAGE =
  "Memory tracking is not enabled for this project. Run `memory_init` to create the memory store and enable it.";

function formatRecall(result: Awaited<ReturnType<MemoryManager["recall"]>>): string {
  if (result.memories.length === 0) {
    return `No memory matches found.`;
  }

  const sections: string[] = [`Search mode: ${result.searchMode}`];

  sections.push(
    `Memories:\n${result.memories
      .map(
        (memory) =>
          `- [${memory.category}] ${memory.id.slice(0, 8)} ${memory.content}`,
      )
      .join("\n")}`,
  );

  return sections.join("\n\n");
}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

const injectedSessions = new Set<string>();

async function injectMemoryMessage(ctx: ExtensionContext) {
  const manager = await getManager(ctx.cwd);
  if (!(await manager.isReady())) {
    return;
  }

  const promptContext = await manager.buildPromptContext();
  if (!promptContext) {
    return;
  }

  return {
    message: {
      customType: "project_memory",
      content: `Project memory:\n${promptContext}`,
      display: false,
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    for (const entry of managers.values()) {
      const manager = await entry;
      await manager.close();
    }
    managers.clear();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (injectedSessions.has(sessionId)) {
      return;
    }

    const result = await injectMemoryMessage(ctx);
    if (result) {
      injectedSessions.add(sessionId);
    }
    return result;
  });

  pi.on("session_compact", async () => {
    // After compaction, the injected message may have been summarized away.
    // Clear tracking so the next before_agent_start re-injects.
    injectedSessions.clear();
  });

  pi.registerTool({
    name: "memory_remember",
    label: "Memory Remember",
    description: "Store a new project memory in NDJSON and sync the local index.",
    promptSnippet: "Store durable project knowledge, practices, or decisions",
    promptGuidelines: [
      "Use memory_remember proactively, without waiting for the user to ask, whenever the conversation establishes a reusable project fact.",
      "Compress each memory into one terse, self-contained sentence. Do not include rationale, examples, or prose.",
      "Do not include session-specific context such as turn numbers, option labels like 'Option A', timestamps, or references to the current conversation.",
      "Encode as knowledge when the fact describes what the codebase is: tech stack, dependencies, directory layout, external APIs, or build/test commands.",
      "Encode as practices when the fact describes how the codebase works: naming conventions, coding patterns, test style, file organization, or repeated workflows.",
      "Encode as decisions when the fact explains why a choice was made: architecture tradeoffs, rejected alternatives, scope boundaries, or library selection rationale.",
      "Choose the most specific memory_remember category: knowledge, practices, or decisions.",
      "After writing a memory, continue the task without asking the user for confirmation.",
    ],
    parameters: Type.Object({
      category: Type.Union(
        MEMORY_CATEGORIES.map((entry) => Type.Literal(entry)),
        { description: "Destination category file" },
      ),
      content: Type.String({
        description: "The memory content to store",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager(ctx.cwd);
      if (!(await manager.isReady())) {
        return textResult(NOT_ENABLED_MESSAGE, { enabled: false });
      }

      const result = await manager.remember(params.category, params.content);
      return textResult(
        result.created
          ? `Stored ${params.category} memory ${result.memory.id}.`
          : `Matching ${params.category} memory already exists as ${result.memory.id}.`,
        { id: result.memory.id, created: result.created },
      );
    },
  });

  pi.registerTool({
    name: "memory_recall",
    label: "Memory Recall",
    description:
      "Retrieve relevant project memories using local semantic search with fallbacks.",
    promptSnippet: "Retrieve relevant project memories before acting",
    promptGuidelines: [
      "Use memory_recall when the user asks about project conventions, history, architecture, or why something is the way it is.",
      "Use memory_recall before changing project patterns, conventions, file organization, or architecture to check for existing guidance.",
      "Use memory_recall's category parameter only when the query is clearly about knowledge, practices, or decisions.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      category: Type.Optional(
        Type.Union(MEMORY_CATEGORIES.map((entry) => Type.Literal(entry))),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum number of results to return",
          minimum: 1,
          maximum: 20,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager(ctx.cwd);
      if (!(await manager.isReady())) {
        return textResult(NOT_ENABLED_MESSAGE, { enabled: false });
      }

      const result = await manager.recall({
        query: params.query,
        category: params.category,
        limit: params.limit,
      });
      return textResult(formatRecall(result), {
        searchMode: result.searchMode,
        memoryCount: result.memories.length,
      });
    },
  });

  pi.registerTool({
    name: "memory_update",
    label: "Memory Update",
    description:
      "Replace the content of an existing memory by id and resync the local index.",
    parameters: Type.Object({
      id: Type.String({ description: "Memory id to update" }),
      content: Type.String({ description: "New memory content" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager(ctx.cwd);
      if (!(await manager.isReady())) {
        return textResult(NOT_ENABLED_MESSAGE, { enabled: false });
      }

      const updated = await manager.update(params.id, params.content);
      if (!updated) {
        return textResult(`No memory found with id ${params.id}.`, {
          updated: false,
        });
      }

      return textResult(`Updated memory ${updated.id}.`, {
        updated: true,
        id: updated.id,
      });
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description:
      "Remove a memory from the NDJSON source of truth and local search index.",
    parameters: Type.Object({
      id: Type.String({ description: "Memory id to remove" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager(ctx.cwd);
      if (!(await manager.isReady())) {
        return textResult(NOT_ENABLED_MESSAGE, { enabled: false });
      }

      const removed = await manager.forget(params.id);
      if (!removed) {
        return textResult(`No memory found with id ${params.id}.`, {
          removed: false,
        });
      }

      return textResult(`Removed memory ${removed.id}.`, {
        removed: true,
        id: removed.id,
      });
    },
  });

  // Lifecycle / review tools are intentionally NOT given promptSnippet or
  // promptGuidelines. They should only be used when the user explicitly asks
  // for memory initialization, session review, or consolidation.

  pi.registerTool({
    name: "memory_init",
    label: "Memory Init",
    description:
      "Bootstrap .pi/memory NDJSON files and build the local search index. Optionally seed initial knowledge/practices, or force-rebuild the index from the NDJSON source of truth.",
    parameters: Type.Object({
      seed: Type.Optional(
        Type.Boolean({
          description: "Scan the project and auto-seed initial knowledge and practices",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "Rebuild the vector and FTS search index from scratch",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager(ctx.cwd);
      const result = await manager.init(Boolean(params.force), Boolean(params.seed));
      const seedText = params.seed
        ? ` created ${result.createdMemories}, skipped ${result.skippedMemories},`
        : "";
      const forceText = params.force ? " (rebuilt index)" : "";
      return textResult(
        `Initialized memory${forceText}.${seedText} semantic ${result.semanticEnabled ? "enabled" : "fallback-only"}.`,
        result,
      );
    },
  });

  pi.registerTool({
    name: "memory_learn",
    label: "Memory Learn",
    description:
      "Review recent activity and suggest new memories without writing them.",
    parameters: Type.Object({
      since: Type.Optional(
        Type.String({
          description: "ISO timestamp lower bound for activity review",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager(ctx.cwd);
      if (!(await manager.isReady())) {
        return textResult(NOT_ENABLED_MESSAGE, { enabled: false });
      }

      const snippets = await manager.learn(params.since);
      return textResult(
        snippets.length > 0
          ? `Recent conversations from ${snippets.filter((s) => s.startsWith("--- Session")).length} sessions:\n\n${snippets.join("\n")}`
          : "No recent sessions found. Use `memory_remember` to add memories manually.",
        { sessionCount: snippets.filter((s) => s.startsWith("--- Session")).length },
      );
    },
  });

  pi.registerTool({
    name: "memory_consolidate",
    label: "Memory Consolidate",
    description:
      "Review stored memories and suggest duplicate or merge candidates without mutating files.",
    parameters: Type.Object({
      since: Type.Optional(
        Type.String({
          description: "Only review memories created or updated after this ISO timestamp",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager(ctx.cwd);
      if (!(await manager.isReady())) {
        return textResult(NOT_ENABLED_MESSAGE, { enabled: false });
      }

      const suggestions = await manager.consolidate(params.since);
      return textResult(suggestions.map((entry) => `- ${entry}`).join("\n"), {
        count: suggestions.length,
      });
    },
  });

  pi.registerTool({
    name: "memory_list",
    label: "Memory List",
    description: "List stored memories and category counts.",
    promptSnippet: "Audit stored project memories",
    promptGuidelines: [
      "Use memory_list when the user asks what the project remembers, or before consolidating/updating memories.",
    ],
    parameters: Type.Object({
      category: Type.Optional(
        Type.String({
          description: "Optional category filter",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager(ctx.cwd);
      if (!(await manager.isReady())) {
        return textResult(NOT_ENABLED_MESSAGE, { enabled: false });
      }

      const { memories, counts } = await manager.list();
      const filtered = isMemoryCategory(params.category)
        ? memories.filter((memory) => memory.category === params.category)
        : memories;

      const header = `Counts: knowledge=${counts.knowledge}, practices=${counts.practices}, decisions=${counts.decisions}`;
      if (filtered.length === 0) {
        return textResult(`${header}\n\nNo stored memories.`);
      }

      const body = filtered
        .map(
          (memory) =>
            `- [${memory.category}] ${memory.id.slice(0, 8)} ${memory.content}`,
        )
        .join("\n");
      return textResult(`${header}\n\n${body}`, { count: filtered.length });
    },
  });
}
