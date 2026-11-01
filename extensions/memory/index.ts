import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type DuplicateIdWarning,
  MemoryManager,
} from "./core.ts";
import { publishExtensionSettings } from "../../lib/pi-tools-config.ts";
import { FOREGROUND_REVIEW_PROMPT } from "./foreground-review.ts";
import { blocksForegroundMemoryWrite } from "./foreground-path-guard.ts";
import {
  isExtensionEnabled,
  removeDisabledTools,
} from "../../lib/pi-tools-runtime-settings.ts";

const MEMORY_EXTENSION_ID = "memory";
const MEMORY_TOOL_NAMES = [
  "memory_remember",
  "memory_recall",
  "memory_update",
  "memory_forget",
  "memory_init",
  "memory_repair",
  "memory_consolidate",
  "memory_list",
] as const;

function isMemoryCategory(value: string | undefined): value is MemoryCategory {
  return (
    value !== undefined && MEMORY_CATEGORIES.includes(value as MemoryCategory)
  );
}

const NOT_ENABLED_MESSAGE =
  "Memory tracking is not enabled for this project. Run `memory_init` to create the memory store and enable it.";

const DUPLICATE_REVIEW_GUIDANCE =
  "Inspect the memory files and resolve duplicate IDs explicitly before writing.";

function formatDuplicateWarning(warning: DuplicateIdWarning): string {
  return `Duplicate memory id ${warning.id}. ${DUPLICATE_REVIEW_GUIDANCE}`;
}

function formatRecall(
  result: Awaited<ReturnType<MemoryManager["recall"]>>,
): string {
  const warnings = result.warnings?.map(formatDuplicateWarning).join("\n");
  const fallback =
    result.searchMode === "grep" && result.warnings?.length
      ? "Duplicate IDs prevent indexing. Search uses case-insensitive literal substring matching and may miss relevant memories."
      : undefined;
  if (result.memories.length === 0) {
    return [
      `Search mode: ${result.searchMode}`,
      fallback,
      "No memory matches found.",
      warnings,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const sections: string[] = [`Search mode: ${result.searchMode}`];
  if (fallback) sections.push(fallback);
  if (warnings) sections.push(`Memory warnings:\n${warnings}`);

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

type RememberResultDetails = {
  kind: "memory_remember";
  category: MemoryCategory;
  content: string;
  id: string;
  created: boolean;
};

function isRememberResultDetails(
  details: unknown,
): details is RememberResultDetails {
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { kind?: unknown }).kind === "memory_remember" &&
    isMemoryCategory((details as { category?: string }).category) &&
    typeof (details as { content?: unknown }).content === "string" &&
    typeof (details as { id?: unknown }).id === "string" &&
    typeof (details as { created?: unknown }).created === "boolean"
  );
}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export default function (pi: ExtensionAPI) {
  const managers = new Map<string, Promise<MemoryManager>>();
  const injectedSessions = new Set<string>();
  const warnedConflicts = new Map<string, string>();
  // Factory state belongs to one extension runtime/session, not the module.
  let foregroundReview = false;
  let pendingForegroundCommand = false;
  function warnDiagnostics(
    ctx: ExtensionContext,
    warnings: DuplicateIdWarning[],
  ): boolean {
    if (!warnings.length) {
      warnedConflicts.delete(ctx.cwd);
      return false;
    }
    const signature = JSON.stringify(
      warnings
        .map((warning) => [
          warning.id,
          warning.locations
            .map(({ category, line }) => `${category}:${line}`)
            .sort(),
        ])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
    if (warnedConflicts.get(ctx.cwd) !== signature) {
      warnedConflicts.set(ctx.cwd, signature);
      const details = warnings
        .map(
          (warning) =>
            `${warning.id} (${warning.locations.map(({ category, line }) => `.pi/memory/${category}.ndjson:${line}`).join(", ")})`,
        )
        .join("; ");
      const message = `Duplicate memory IDs: ${details}. ${DUPLICATE_REVIEW_GUIDANCE} Memory was not changed by this warning.`;
      try {
        if (ctx.hasUI && typeof ctx.ui.notify === "function")
          ctx.ui.notify(message, "warning");
        else console.error(message);
      } catch {
        console.error(message);
      }
    }
    return true;
  }
  function warnConflict(ctx: ExtensionContext, error: unknown): boolean {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith("Memory conflict: duplicate id ")
    )
      return false;
    if (warnedConflicts.get(ctx.cwd) !== error.message) {
      warnedConflicts.set(ctx.cwd, error.message);
      const message = `${error.message}. ${DUPLICATE_REVIEW_GUIDANCE} Memory was not changed by this operation.`;
      try {
        if (ctx.hasUI && typeof ctx.ui.notify === "function")
          ctx.ui.notify(message, "warning");
        else console.error(message);
      } catch {
        console.error(message);
      }
    }
    return true;
  }
  function getManager(cwd: string): Promise<MemoryManager> {
    let manager = managers.get(cwd);
    if (!manager) {
      manager = Promise.resolve(new MemoryManager(cwd));
      managers.set(cwd, manager);
    }
    return manager;
  }

  async function getReadyManager(
    ctx: ExtensionContext,
  ): Promise<MemoryManager | undefined> {
    if (
      !(await isExtensionEnabled(ctx, CONFIG_DIR_NAME, MEMORY_EXTENSION_ID))
    ) {
      return undefined;
    }
    const ready = await getManager(ctx.cwd);
    return (await ready.isReady()) ? ready : undefined;
  }

  async function injectMemoryMessage(ctx: ExtensionContext) {
    const manager = await getReadyManager(ctx);
    if (!manager) return;
    const promptContext = await manager.buildPromptContext();
    warnDiagnostics(ctx, manager.getWarnings());
    if (!promptContext) return null;
    return {
      message: {
        customType: "project_memory",
        content: `Project memory:\n${promptContext}`,
        display: false,
      },
    };
  }

  publishExtensionSettings(pi.events, {
    id: MEMORY_EXTENSION_ID,
    label: "Project Memory",
    description:
      "Enables project memory tools and automatic memory-context injection.",
    fields: {
      enabled: {
        type: "boolean",
        default: true,
        label: "Enabled",
      },
    },
    toolNames: MEMORY_TOOL_NAMES,
  });

  pi.on("session_start", async (_event, ctx) => {
    removeDisabledTools(
      pi,
      MEMORY_TOOL_NAMES,
      await isExtensionEnabled(ctx, CONFIG_DIR_NAME, MEMORY_EXTENSION_ID),
    );
  });

  pi.on("agent_settled", () => {
    foregroundReview = false;
    pendingForegroundCommand = false;
  });

  // Tool calls in an assistant message may execute in parallel. Arm before any
  // sibling call can write, even if the review tool later fails validation.
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    if (
      event.message.content.some(
        (part) =>
          part.type === "toolCall" && part.name === "memory_consolidate",
      )
    )
      foregroundReview = true;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (
      !foregroundReview ||
      (event.toolName !== "write" && event.toolName !== "edit")
    )
      return;
    if (await blocksForegroundMemoryWrite(ctx.cwd, event.input.path))
      return {
        block: true,
        reason:
          "Foreground memory review cannot write memory files directly; use guarded memory tools.",
      };
  });

  pi.on("session_shutdown", async () => {
    foregroundReview = false;
    pendingForegroundCommand = false;
    const entries = [...managers.values()];
    managers.clear();
    for (const entry of entries) {
      const manager = await entry;
      await manager.close();
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // A dispatched command can fail before a run starts. Do not retain its
    // guard when the next accepted prompt is unrelated.
    if (pendingForegroundCommand) {
      foregroundReview = event.prompt === FOREGROUND_REVIEW_PROMPT;
      pendingForegroundCommand = false;
    }
    const sessionId = ctx.sessionManager.getSessionId();
    if (injectedSessions.has(sessionId)) {
      return;
    }

    let result: Awaited<ReturnType<typeof injectMemoryMessage>>;
    try {
      result = await injectMemoryMessage(ctx);
    } catch (error) {
      if (!warnConflict(ctx, error)) throw error;
      return;
    }
    if (result !== undefined) {
      injectedSessions.add(sessionId);
    }
    return result ?? undefined;
  });

  pi.on("session_compact", async (_event, ctx) => {
    // The message may have been summarized away; reinject for this session.
    injectedSessions.delete(ctx.sessionManager.getSessionId());
  });

  pi.registerTool({
    name: "memory_remember",
    label: "Memory Remember",
    description:
      "Store a new project memory in NDJSON and sync the local index.",
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
    renderResult(result, _options, theme) {
      const first = result.content[0];
      const confirmation =
        first?.type === "text" ? first.text : "Memory result completed.";
      const details = isRememberResultDetails(result.details)
        ? result.details
        : undefined;
      if (!details) return new Text(theme.fg("dim", confirmation), 0, 0);

      return new Text(
        [
          theme.fg("dim", confirmation),
          theme.fg("accent", `${details.category} memory`),
          details.content,
        ].join("\n"),
        0,
        0,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getReadyManager(ctx);
      if (!manager) return textResult(NOT_ENABLED_MESSAGE, { enabled: false });

      const result = await manager.remember(params.category, params.content);
      return textResult(
        result.created
          ? `Stored ${params.category} memory.`
          : `Matching ${params.category} memory already exists.`,
        {
          kind: "memory_remember",
          category: params.category,
          content: result.memory.content,
          id: result.memory.id,
          created: result.created,
        } satisfies RememberResultDetails,
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
      const manager = await getReadyManager(ctx);
      if (!manager) return textResult(NOT_ENABLED_MESSAGE, { enabled: false });

      const result = await manager.recall({
        query: params.query,
        category: params.category,
        limit: params.limit,
      });
      warnDiagnostics(ctx, result.warnings ?? []);
      return textResult(formatRecall(result), {
        searchMode: result.searchMode,
        memoryCount: result.memories.length,
        warnings: (result.warnings ?? []).map((warning) => ({
          ...warning,
          message: formatDuplicateWarning(warning),
        })),
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
      expectedContent: Type.Optional(
        Type.String({
          description:
            "Exact previously reviewed content; reject changes if the target differs.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (foregroundReview && params.expectedContent === undefined)
        throw new Error(
          "Foreground memory review requires expectedContent for updates; inspect the target first.",
        );
      const manager = await getReadyManager(ctx);
      if (!manager) return textResult(NOT_ENABLED_MESSAGE, { enabled: false });

      const expected =
        params.expectedContent === undefined
          ? undefined
          : await manager.captureWritePrecondition(params.id);
      if (params.expectedContent !== undefined) {
        if (!expected)
          throw new Error(
            "Memory update conflict: target not found; review again.",
          );
        let current: unknown;
        try {
          current = JSON.parse(expected.rawLine)?.content;
        } catch {
          throw new Error(
            "Memory update conflict: target is unreadable; review again.",
          );
        }
        if (current !== params.expectedContent)
          throw new Error(
            "Memory update conflict: content changed; review again.",
          );
      }
      const updated = await manager.update(
        params.id,
        params.content,
        expected ?? undefined,
      );
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
      expectedContent: Type.Optional(
        Type.String({
          description:
            "Exact previously reviewed content; reject changes if the target differs.",
        }),
      ),
      retainedId: Type.Optional(
        Type.String({
          description:
            "For duplicate removal, the complete ID of the memory to retain.",
        }),
      ),
      expectedRetainedContent: Type.Optional(
        Type.String({
          description:
            "Exact reviewed content of the retained memory; requires retainedId and expectedContent.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getReadyManager(ctx);
      if (!manager) return textResult(NOT_ENABLED_MESSAGE, { enabled: false });

      if (
        foregroundReview &&
        (params.expectedContent === undefined ||
          params.retainedId === undefined ||
          params.expectedRetainedContent === undefined)
      )
        throw new Error(
          "Foreground memory review only removes duplicates with expectedContent, retainedId, and expectedRetainedContent; report other removals instead.",
        );
      const hasRetained =
        params.retainedId !== undefined ||
        params.expectedRetainedContent !== undefined;
      if (
        hasRetained &&
        (params.retainedId === undefined ||
          params.expectedRetainedContent === undefined ||
          params.expectedContent === undefined ||
          params.retainedId === params.id)
      )
        throw new Error(
          "Memory removal conflict: duplicate removal requires a distinct retainedId, expectedRetainedContent, and expectedContent.",
        );
      const snapshot = hasRetained
        ? await manager.captureAddPrecondition()
        : undefined;
      if (snapshot) {
        const matches: unknown[] = [];
        for (const category of MEMORY_CATEGORIES) {
          for (const line of snapshot.snapshots[category].contents.split(
            "\n",
          )) {
            try {
              const entry = JSON.parse(line);
              if (entry && entry.id === params.retainedId)
                matches.push(entry.content);
            } catch {
              /* Preserve malformed lines; they are not retained records. */
            }
          }
        }
        if (
          matches.length !== 1 ||
          matches[0] !== params.expectedRetainedContent
        )
          throw new Error(
            "Memory removal conflict: retained memory missing, ambiguous, or changed; review again.",
          );
      }
      const expected =
        params.expectedContent === undefined
          ? undefined
          : await manager.captureWritePrecondition(params.id);
      if (params.expectedContent !== undefined) {
        if (!expected)
          throw new Error(
            "Memory removal conflict: target not found; review again.",
          );
        let current: unknown;
        try {
          current = JSON.parse(expected.rawLine)?.content;
        } catch {
          throw new Error(
            "Memory removal conflict: target is unreadable; review again.",
          );
        }
        if (current !== params.expectedContent)
          throw new Error(
            "Memory removal conflict: content changed; review again.",
          );
      }
      const removed =
        snapshot && expected
          ? await manager.forgetWithSnapshot(params.id, expected, snapshot)
          : await manager.forget(params.id, expected ?? undefined);
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
      "Bootstrap .pi/memory NDJSON files, then build the local search index. Malformed lines are preserved; use memory_repair to remove them. Optionally seed initial knowledge/practices, or force-rebuild the index from the NDJSON source of truth.",
    parameters: Type.Object({
      seed: Type.Optional(
        Type.Boolean({
          description:
            "Scan the project and auto-seed initial knowledge and practices",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "Rebuild the vector and FTS search index from scratch",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (
        !(await isExtensionEnabled(ctx, CONFIG_DIR_NAME, MEMORY_EXTENSION_ID))
      ) {
        return textResult(NOT_ENABLED_MESSAGE, { enabled: false });
      }
      const manager = await getManager(ctx.cwd);
      const result = await manager.init(
        Boolean(params.force),
        Boolean(params.seed),
      );
      const seedText = params.seed
        ? ` created ${result.createdMemories}, skipped ${result.skippedMemories},`
        : "";
      const forceText = params.force ? " (rebuilt index)" : "";
      return textResult(
        `Initialized memory${forceText}.${seedText} Semantic ${result.semanticEnabled ? "enabled" : "fallback-only"}.`,
        result,
      );
    },
  });

  pi.registerTool({
    name: "memory_repair",
    label: "Memory Repair",
    description:
      "Remove malformed NDJSON lines while retaining valid memories, then resync the local index.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const manager = await getReadyManager(ctx);
      if (!manager) return textResult(NOT_ENABLED_MESSAGE, { enabled: false });

      const result = await manager.repair();
      const detail = MEMORY_CATEGORIES.map(
        (category) => `${category}=${result.removedLines[category]}`,
      ).join(", ");
      return textResult(
        result.totalRemovedLines > 0
          ? `Removed ${result.totalRemovedLines} malformed NDJSON line${result.totalRemovedLines === 1 ? "" : "s"} (${detail}) and resynced the index.`
          : "No malformed NDJSON lines found.",
        result,
      );
    },
  });

  async function foregroundReviewReady(
    ctx: ExtensionContext,
  ): Promise<string | undefined> {
    if (!ctx.isProjectTrusted())
      return "Project trust is required for memory review.";
    if (!(await getReadyManager(ctx))) return NOT_ENABLED_MESSAGE;
    return undefined;
  }

  pi.registerTool({
    name: "memory_consolidate",
    label: "Memory Consolidate",
    description:
      "Start foreground memory consolidation only when the user explicitly requests it; continue the review in this agent session using normal tools.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const error = await foregroundReviewReady(ctx);
      if (error) return textResult(error, { failed: true });
      foregroundReview = true;
      return textResult(FOREGROUND_REVIEW_PROMPT, { foreground: true });
    },
  });

  // The tool is also available in headless/RPC mode; the command is a direct
  // user-facing entry point and never opens a focus-stealing screen.
  pi.registerCommand?.("memory-review", {
    description: "Start foreground memory review",
    handler: async (args, ctx) => {
      if (args.trim()) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /memory-review", "warning");
        return;
      }
      const error = await foregroundReviewReady(ctx);
      if (error) {
        if (ctx.hasUI) ctx.ui.notify(error, "warning");
        return;
      }
      if (!ctx.isIdle()) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Agent is busy. Run /memory-review when idle.",
            "warning",
          );
        return;
      }
      foregroundReview = true;
      pendingForegroundCommand = true;
      try {
        pi.sendUserMessage(FOREGROUND_REVIEW_PROMPT);
      } catch (error) {
        foregroundReview = false;
        pendingForegroundCommand = false;
        throw error;
      }
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
      const manager = await getReadyManager(ctx);
      if (!manager) return textResult(NOT_ENABLED_MESSAGE, { enabled: false });

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
