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

  const created = (async () => {
    const manager = new MemoryManager(cwd);
    await manager.initialize();
    return manager;
  })();

  managers.set(cwd, created);
  return created;
}

async function updateStatus(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  try {
    const manager = await getManager(ctx.cwd);
    const { counts } = await manager.list();
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const semantic = manager.isSemanticAvailable() ? "vec" : "fts";
    ctx.ui.setStatus("memory", `memory ${total} (${semantic})`);
  } catch {
    ctx.ui.setStatus("memory", "memory unavailable");
  }
}

function formatRecall(result: Awaited<ReturnType<MemoryManager["recall"]>>): string {
  if (result.memories.length === 0 && result.files.length === 0) {
    return `No memory or file matches found.`;
  }

  const sections: string[] = [`Search mode: ${result.searchMode}`];

  if (result.memories.length > 0) {
    sections.push(
      `Memories:\n${result.memories
        .map(
          (memory) =>
            `- [${memory.category}] ${memory.id.slice(0, 8)} ${memory.content}`,
        )
        .join("\n")}`,
    );
  }

  if (result.files.length > 0) {
    sections.push(
      `Files:\n${result.files
        .map(
          (file) =>
            `- ${file.path}:${file.startLine}-${file.endLine} ${file.content.replace(/\s+/g, " ").slice(0, 180)}`,
        )
        .join("\n")}`,
    );
  }

  return sections.join("\n\n");
}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await getManager(ctx.cwd);
    await updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    for (const entry of managers.values()) {
      const manager = await entry;
      await manager.close();
    }
    managers.clear();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const manager = await getManager(ctx.cwd);
    const promptContext = await manager.buildPromptContext();
    if (!promptContext) {
      return;
    }

    return {
      systemPrompt: `${ctx.getSystemPrompt()}\n\nProject memory:\n${promptContext}`,
    };
  });

  pi.on("input", async (event, ctx) => {
    const manager = await getManager(ctx.cwd);
    await manager.logActivity("input", event.text);
  });

  pi.registerTool({
    name: "memory_remember",
    label: "Memory Remember",
    description: "Store a new project memory in NDJSON and sync the local index.",
    promptSnippet: "Store a durable project memory",
    promptGuidelines: [
      "Use this for stable project facts, conventions, or decisions worth keeping across sessions.",
      "Choose the most specific category: knowledge, practices, or decisions.",
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
      const result = await manager.remember(params.category, params.content);
      await updateStatus(ctx);
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
      "Retrieve relevant project memories and indexed repo file chunks using local semantic search with fallbacks.",
    promptSnippet: "Recall project memory and indexed repo context",
    promptGuidelines: [
      "Use category when the user is clearly asking about knowledge, practices, or decisions only.",
      "When category is omitted, this searches both stored memories and indexed repo files.",
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
      force_file_sync: Type.Optional(
        Type.Boolean({
          description: "Re-scan repo files before searching",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager(ctx.cwd);
      const result = await manager.recall({
        query: params.query,
        category: params.category,
        limit: params.limit,
        forceFileSync: params.force_file_sync,
      });
      await updateStatus(ctx);
      return textResult(formatRecall(result), {
        searchMode: result.searchMode,
        memoryCount: result.memories.length,
        fileCount: result.files.length,
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
      const updated = await manager.update(params.id, params.content);
      await updateStatus(ctx);
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
      const removed = await manager.forget(params.id);
      await updateStatus(ctx);
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

  pi.registerTool({
    name: "memory_init",
    label: "Memory Init",
    description:
      "Bootstrap .pi/memory NDJSON files, seed initial knowledge/practices, and index repo files.",
    parameters: Type.Object({
      force: Type.Optional(
        Type.Boolean({
          description: "Force a full repo file re-index",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager(ctx.cwd);
      const result = await manager.init(Boolean(params.force));
      await updateStatus(ctx);
      return textResult(
        `Initialized memory: created ${result.createdMemories}, skipped ${result.skippedMemories}, indexed ${result.indexedFiles} files, skipped ${result.skippedFiles}, removed ${result.removedFiles}, chunks ${result.chunksIndexed}, semantic ${result.semanticEnabled ? "enabled" : "fallback-only"}.`,
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
      const suggestions = await manager.learn(params.since);
      await updateStatus(ctx);
      return textResult(
        suggestions.length > 0
          ? `Suggested memories:\n${suggestions.map((entry) => `- ${entry}`).join("\n")}`
          : "No new memory suggestions found.",
        { count: suggestions.length },
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
      const suggestions = await manager.consolidate(params.since);
      await updateStatus(ctx);
      return textResult(suggestions.map((entry) => `- ${entry}`).join("\n"), {
        count: suggestions.length,
      });
    },
  });

  pi.registerTool({
    name: "memory_list",
    label: "Memory List",
    description: "List stored memories and category counts.",
    parameters: Type.Object({
      category: Type.Optional(
        Type.String({
          description: "Optional category filter",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager(ctx.cwd);
      const { memories, counts } = await manager.list();
      const filtered = isMemoryCategory(params.category)
        ? memories.filter((memory) => memory.category === params.category)
        : memories;
      await updateStatus(ctx);

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
