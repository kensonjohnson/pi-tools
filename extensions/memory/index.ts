import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    for (const entry of managers.values()) {
      const manager = await entry;
      await manager.close();
    }
    managers.clear();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const manager = await getManager(ctx.cwd);
    if (!(await manager.isReady())) {
      return;
    }

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
    if (await manager.isReady()) {
      await manager.logActivity("input", event.text);
    }
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
    promptSnippet: "Recall project memory",
    promptGuidelines: [
      "Use category when the user is clearly asking about knowledge, practices, or decisions only.",
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

  pi.registerTool({
    name: "memory_init",
    label: "Memory Init",
    description:
      "Bootstrap .pi/memory NDJSON files and build the local search index. Optionally seed initial knowledge/practices from the project.",
    parameters: Type.Object({
      seed: Type.Optional(
        Type.Boolean({
          description: "Scan the project and auto-seed initial knowledge and practices",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager(ctx.cwd);
      const result = await manager.init(Boolean(params.seed));
      const seedText = params.seed
        ? ` created ${result.createdMemories}, skipped ${result.skippedMemories},`
        : "";
      return textResult(
        `Initialized memory.${seedText} semantic ${result.semanticEnabled ? "enabled" : "fallback-only"}.`,
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

      const suggestions = await manager.learn(params.since);
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
