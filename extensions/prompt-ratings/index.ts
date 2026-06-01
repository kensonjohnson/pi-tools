/**
 * Prompt Ratings Extension
 *
 * Captures every assistant message, embeds prompts/responses locally,
 * and provides upvote/downvote/skip ratings with search + stats.
 *
 * Commands:
 *   /u            — upvote latest unrated response
 *   /d            — downvote latest unrated response
 *   /s            — skip latest unrated response (explicit neutral)
 *   /rate_search  — search rated prompt/response history
 *   /votestats    — show model rating statistics dashboard
 *
 * Shortcuts:
 *   Ctrl+Shift+U — upvote
 *   Ctrl+Shift+D — downvote
 *   Ctrl+Shift+S — skip
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RatingDB } from "./db";

// ─── Module-level state ───────────────────────────────────────────────────────

const db = new RatingDB();
let dbReady = false;

interface PendingPrompt {
  text: string;
  provider: string;
  id: string;
  name: string;
}

let pendingPrompt: PendingPrompt | null = null;
let latestUnratedId: number | null = null;

async function ensureDb(): Promise<boolean> {
  if (dbReady) return true;
  try {
    await db.initialize();
    dbReady = true;
    return true;
  } catch (e) {
    console.error("[prompt-ratings] DB init failed:", e);
    return false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getPromptText(message: { content?: unknown }): string {
  if (!message.content) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c): c is { type: string; text?: string } =>
        typeof c === "object" && c !== null && "type" in c,
      )
      .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
      .join(" ");
  }
  return String(message.content);
}

function updateWidget(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;

  if (latestUnratedId === null) {
    ctx.ui.setWidget("prompt-ratings", undefined);
    return;
  }

  const interaction = db.getById(latestUnratedId);
  if (!interaction) {
    latestUnratedId = null;
    ctx.ui.setWidget("prompt-ratings", undefined);
    return;
  }

  const preview = interaction.responseText.slice(0, 60).replace(/\n/g, " ");
  const suffix = interaction.responseText.length > 60 ? "…" : "";
  const model = interaction.modelName ?? interaction.modelId ?? "unknown";

  ctx.ui.setWidget("prompt-ratings", [
    `Rate last response (${model}): "${preview}${suffix}"`,
    `[👍 /u] [👎 /d] [⊘ /s]`,
  ]);
}

function rate(rating: number, ctx: ExtensionContext): { ok: boolean; msg: string } {
  if (latestUnratedId === null) {
    return { ok: false, msg: "No unrated response to rate." };
  }

  const ok = db.updateRating(latestUnratedId, rating);
  if (!ok) {
    return { ok: false, msg: `Failed to update rating for interaction ${latestUnratedId}.` };
  }

  const label = rating === 1 ? "upvoted" : rating === -1 ? "downvoted" : "skipped";
  const msg = `Response ${latestUnratedId} ${label}.`;
  latestUnratedId = null;
  updateWidget(ctx);
  return { ok: true, msg };
}

async function doSearch(params: {
  query: string;
  searchIn?: "prompt" | "response" | "both";
  limit?: number;
  minRating?: number;
}): Promise<string> {
  if (!(await ensureDb())) {
    return "Database not available.";
  }

  const searchIn = params.searchIn ?? "both";
  const limit = params.limit ?? 10;

  const hits = await db.searchInteractions({
    query: params.query,
    searchIn,
    limit,
  });

  let filtered = hits;
  if (params.minRating !== undefined) {
    filtered = hits.filter((h) => h.rating >= params.minRating!);
  }

  if (filtered.length === 0) {
    return `No results for "${params.query}".`;
  }

  const lines = filtered.map((h) => {
    const ratingLabel = h.rating === 1 ? "👍" : h.rating === -1 ? "👎" : "⊘";
    const model = h.modelName ?? h.modelId ?? "unknown";
    const promptPreview = h.promptText.slice(0, 100).replace(/\n/g, " ");
    const responsePreview = h.responseText.slice(0, 100).replace(/\n/g, " ");
    return `[${ratingLabel}] ${model} (score ${h.score.toFixed(3)} ${h.source})\n  Prompt: ${promptPreview}${h.promptText.length > 100 ? "…" : ""}\n  Response: ${responsePreview}${h.responseText.length > 100 ? "…" : ""}`;
  });

  return lines.join("\n\n");
}

function formatUpvoteDownvoteRatio(up: number, down: number): string {
  if (up === 0 && down === 0) return "—";
  return `${up}:${down}`;
}

// ─── Extension factory ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ─── Events ────────────────────────────────────────────────────────────────

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!(await ensureDb())) return;

    const model = _ctx.model;
    pendingPrompt = {
      text: event.prompt,
      provider: model?.provider ?? "unknown",
      id: model?.id ?? "unknown",
      name: model?.name ?? model?.id ?? "unknown",
    };
  });

  pi.on("message_end", async (event, ctx) => {
    if (!(await ensureDb())) return;
    if (event.message.role !== "assistant") return;
    if (!pendingPrompt) return;

    const responseText = getPromptText(event.message);
    if (!responseText.trim()) return;

    const sessionFile = ctx.sessionManager.getSessionFile() ?? "ephemeral";
    const entryId = event.message.id ?? "unknown";

    try {
      const id = await db.insertInteraction({
        sessionFile,
        entryId,
        cwd: ctx.cwd,
        promptText: pendingPrompt.text,
        responseText,
        modelProvider: pendingPrompt.provider,
        modelId: pendingPrompt.id,
        modelName: pendingPrompt.name,
      });

      latestUnratedId = id;
      updateWidget(ctx);
    } catch (e) {
      console.error("[prompt-ratings] Failed to insert interaction:", e);
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    updateWidget(ctx);
  });

  pi.on("session_shutdown", async () => {
    pendingPrompt = null;
    latestUnratedId = null;
    if (dbReady) {
      await db.close();
      dbReady = false;
    }
  });

  // ─── Commands ────────────────────────────────────────────────────────────────

  pi.registerCommand("u", {
    description: "Upvote the last unrated assistant response",
    handler: async (_args, ctx) => {
      const result = rate(1, ctx);
      ctx.ui.notify(result.msg, result.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("d", {
    description: "Downvote the last unrated assistant response",
    handler: async (_args, ctx) => {
      const result = rate(-1, ctx);
      ctx.ui.notify(result.msg, result.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("s", {
    description: "Skip (neutral) the last unrated assistant response",
    handler: async (_args, ctx) => {
      const result = rate(0, ctx);
      ctx.ui.notify(result.msg, result.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("rate_search", {
    description: "Search rated prompt/response history: /rate_search <query> [--in prompt|response|both] [--limit N] [--min-rating -1|0|1]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /rate_search <query> [--in prompt|response|both] [--limit N] [--min-rating -1|0|1]", "warning");
        return;
      }

      const flags: Record<string, string> = {};
      let query = trimmed;

      const flagPattern = /--(in|limit|min-rating)\s+(\S+)/g;
      let match: RegExpExecArray | null;
      while ((match = flagPattern.exec(trimmed)) !== null) {
        flags[match[1]] = match[2];
      }

      query = trimmed.replace(flagPattern, "").trim().replace(/\s+/g, " ");

      if (!query) {
        ctx.ui.notify("Usage: /rate_search <query> [--in prompt|response|both] [--limit N] [--min-rating -1|0|1]", "warning");
        return;
      }

      const searchIn = ["prompt", "response", "both"].includes(flags["in"] ?? "")
        ? (flags["in"] as "prompt" | "response" | "both")
        : "both";

      const limit = flags["limit"] ? Number(flags["limit"]) : 15;
      const minRating = flags["min-rating"] !== undefined ? Number(flags["min-rating"]) : undefined;

      const result = await doSearch({ query, searchIn, limit, minRating });

      pi.sendMessage({
        customType: "prompt-ratings-stats",
        content: `Search: "${query}" (in: ${searchIn}, limit: ${limit}${minRating !== undefined ? `, min-rating: ${minRating}` : ""})\n\n${result}`,
        display: true,
      });
    },
  });

  pi.registerCommand("votestats", {
    description: "Show model rating statistics dashboard",
    handler: async (_args, ctx) => {
      if (!(await ensureDb())) {
        ctx.ui.notify("Database not available.", "error");
        return;
      }

      const providerFilter = _args.trim() || undefined;
      const stats = db.getModelStats(providerFilter);

      if (stats.length === 0) {
        ctx.ui.notify("No ratings recorded yet.", "info");
        return;
      }

      const totalUp = stats.reduce((sum, s) => sum + s.upvotes, 0);
      const totalDown = stats.reduce((sum, s) => sum + s.downvotes, 0);
      const totalSkip = stats.reduce((sum, s) => sum + s.skips, 0);
      const total = totalUp + totalDown + totalSkip;

      const colWidths = {
        model: Math.max(12, ...stats.map((s) => (s.modelName ?? s.modelId ?? "unknown").length)),
        provider: Math.max(8, ...stats.map((s) => (s.modelProvider ?? "unknown").length)),
        counts: 7,
        total: 5,
        ratio: 6,
      };

      const pad = (s: string, w: number) => s.padEnd(w, " ");

      const sep = "─".repeat(
        colWidths.model + colWidths.provider + colWidths.counts + colWidths.total + colWidths.ratio + 14,
      );

      const lines: string[] = [
        `Prompt Ratings Dashboard${providerFilter ? ` — Provider: ${providerFilter}` : ""}`,
        sep,
        `${pad("Model", colWidths.model)}  ${pad("Provider", colWidths.provider)}  Counts    Total  Ratio`,
        sep,
      ];

      for (const s of stats) {
        const name = s.modelName ?? s.modelId ?? "unknown";
        const provider = s.modelProvider ?? "unknown";
        const counts = `↑${s.upvotes} ↓${s.downvotes}`;
        const totalStr = String(s.total);
        const ratio = formatUpvoteDownvoteRatio(s.upvotes, s.downvotes);
        lines.push(
          `${pad(name, colWidths.model)}  ${pad(provider, colWidths.provider)}  ${pad(counts, colWidths.counts)}  ${pad(totalStr, colWidths.total)}  ${pad(ratio, colWidths.ratio)}`,
        );
      }

      lines.push(sep);
      lines.push(`Total: ↑${totalUp} ↓${totalDown} (across ${total} prompts)`);

      const output = lines.join("\n");

      pi.sendMessage({
        customType: "prompt-ratings-stats",
        content: output,
        display: true,
      });
    },
  });

  // ─── Shortcuts ─────────────────────────────────────────────────────────────

  pi.registerShortcut("ctrl+shift+u", {
    description: "Upvote last response",
    handler: async (ctx) => {
      const result = rate(1, ctx);
      ctx.ui.notify(result.msg, result.ok ? "info" : "warning");
    },
  });

  pi.registerShortcut("ctrl+shift+d", {
    description: "Downvote last response",
    handler: async (ctx) => {
      const result = rate(-1, ctx);
      ctx.ui.notify(result.msg, result.ok ? "info" : "warning");
    },
  });

  pi.registerShortcut("ctrl+shift+s", {
    description: "Skip last response",
    handler: async (ctx) => {
      const result = rate(0, ctx);
      ctx.ui.notify(result.msg, result.ok ? "info" : "warning");
    },
  });
}
