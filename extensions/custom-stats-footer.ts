import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

/**
 * Custom Default Footer Extension with TPS
 *
 * Shows:
 * - Context usage: "51k/256k (19%)"
 * - Last TPS: tokens per second from the most recent request
 * - Average TPS: running average across all requests
 */

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatTokensExact(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

// Module-level state to track TPS across agent runs
let agentStartMs: number | null = null;
let lastTps: number | null = null;
let totalTpsSum = 0;
let tpsCount = 0;

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== "object") return false;
  const role = (message as { role?: unknown }).role;
  return role === "assistant";
}

export default function (pi: ExtensionAPI) {
  // Track agent timing for TPS calculation
  pi.on("agent_start", () => {
    agentStartMs = Date.now();
  });

  pi.on("agent_end", (event, _ctx) => {
    if (agentStartMs === null) return;

    const elapsedMs = Date.now() - agentStartMs;
    agentStartMs = null;

    if (elapsedMs <= 0) return;

    let output = 0;
    for (const message of event.messages) {
      if (!isAssistantMessage(message)) continue;
      output += message.usage.output || 0;
    }

    if (output <= 0) return;

    const elapsedSeconds = elapsedMs / 1000;
    const tps = output / elapsedSeconds;

    lastTps = tps;
    totalTpsSum += tps;
    tpsCount++;
  });

  // Function to set up the custom footer
  const setupFooter = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          // Guard against stale context during session shutdown
          let contextWindow = 0;
          let contextTokens = 0;
          let contextPercent = 0;
          let pwd = "";
          let modelName = "";
          let sessionName = "";

          try {
            const contextUsage = ctx.getContextUsage();
            contextWindow =
              contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
            contextTokens = contextUsage?.tokens ?? 0;
            contextPercent = contextUsage?.percent ?? 0;
            pwd = ctx.sessionManager.getCwd();
            modelName = ctx.model?.id || "no-model";
            sessionName = ctx.sessionManager.getSessionName() ?? "";
          } catch {
            // Context became stale during shutdown/reload — return minimal footer
            return [];
          }

          // Build working directory line with git branch
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) {
            pwd = `~${pwd.slice(home.length)}`;
          }

          const branch = footerData.getGitBranch();
          if (branch) {
            pwd = `${pwd} (${branch})`;
          }

          if (sessionName) {
            pwd = `${pwd} • ${sessionName}`;
          }

          // Build stats parts
          const statsParts: string[] = [];

          // Context display: "51k/256k (19%)" - used/window (percentage)
          if (contextWindow > 0) {
            const contextStr = `${formatTokensExact(contextTokens)}/${formatTokens(contextWindow)} (${contextPercent.toFixed(0)}%)`;

            // Colorize based on usage
            let coloredContext: string;
            if (contextPercent > 90) {
              coloredContext = theme.fg("error", contextStr);
            } else if (contextPercent > 70) {
              coloredContext = theme.fg("warning", contextStr);
            } else {
              coloredContext = contextStr;
            }

            statsParts.push(coloredContext);
          }

          // TPS display: "109 tps | 109 avg"
          if (lastTps !== null) {
            const avgTps = tpsCount > 0 ? totalTpsSum / tpsCount : 0;
            const tpsStr = `${lastTps.toFixed(0)} tps | ${avgTps.toFixed(0)} avg`;
            statsParts.push(tpsStr);
          }

          // Model name on the right
          // (modelName already fetched inside try-catch above)

          // Format stats line with " | " separator
          let statsLeft = statsParts.join(" | ");
          let statsLeftWidth = visibleWidth(statsLeft);

          // Truncate if too wide
          if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, "...");
            statsLeftWidth = visibleWidth(statsLeft);
          }

          // Calculate padding for right-alignment
          const minPadding = 2;
          const rightSideWidth = visibleWidth(modelName);
          const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

          let statsLine: string;
          if (totalNeeded <= width) {
            const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
            statsLine = theme.fg("dim", statsLeft + padding + modelName);
          } else {
            const availableForRight = width - statsLeftWidth - minPadding;
            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(
                modelName,
                availableForRight,
                "",
              );
              const padding = " ".repeat(
                Math.max(
                  0,
                  width - statsLeftWidth - visibleWidth(truncatedRight),
                ),
              );
              statsLine = theme.fg("dim", statsLeft + padding + truncatedRight);
            } else {
              statsLine = theme.fg("dim", statsLeft);
            }
          }

          // Build output lines
          const pwdLine = truncateToWidth(
            theme.fg("dim", pwd),
            width,
            theme.fg("dim", "..."),
          );
          const lines = [pwdLine, statsLine];

          // Add extension statuses
          const extensionStatuses = footerData.getExtensionStatuses();
          if (extensionStatuses.size > 0) {
            const sortedStatuses = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) =>
                text
                  .replace(/[\r\n\t]/g, " ")
                  .replace(/ +/g, " ")
                  .trim(),
              );
            const statusLine = sortedStatuses.join(" ");
            lines.push(
              truncateToWidth(statusLine, width, theme.fg("dim", "...")),
            );
          }

          return lines;
        },
      };
    });
  };

  // Set up custom footer on session start
  pi.on("session_start", async (_event, ctx) => {
    setupFooter(ctx);
  });

  // Re-assert footer when agent starts (prevents reset during agent activity)
  pi.on("agent_start", async (_event, ctx) => {
    setupFooter(ctx);
  });
}
