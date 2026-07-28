import { readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  readStoredCredential,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  getSettingValue,
  publishExtensionSettings,
  updateSetting,
} from "../lib/pi-tools-config.ts";
import { getRuntimeSettings } from "../lib/pi-tools-runtime-settings.ts";

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

type QuotaSettings = {
  enabled: boolean;
  refreshMinutes: number;
};

type CodexQuota = {
  remainingPercent: number;
  resetAtMs: number;
};

type RateLimitWindow = {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
  reset_after_seconds?: unknown;
};

const DEFAULT_QUOTA_SETTINGS: QuotaSettings = {
  enabled: false,
  refreshMinutes: 5,
};
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const FOOTER_SETTINGS_ID = "custom-stats-footer";
const LEGACY_QUOTA_SETTINGS_PATH = join(
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  "codex-quota-footer.json",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseQuotaSettings(value: unknown): QuotaSettings {
  if (!isRecord(value)) return { ...DEFAULT_QUOTA_SETTINGS };

  return {
    enabled: value.enabled === true,
    refreshMinutes:
      typeof value.refreshMinutes === "number" &&
      Number.isFinite(value.refreshMinutes) &&
      value.refreshMinutes >= 1
        ? Math.min(value.refreshMinutes, 60)
        : DEFAULT_QUOTA_SETTINGS.refreshMinutes,
  };
}

async function readLegacyQuotaSettings(): Promise<QuotaSettings | undefined> {
  try {
    return parseQuotaSettings(
      JSON.parse(await readFile(LEGACY_QUOTA_SETTINGS_PATH, "utf8")),
    );
  } catch {
    return undefined;
  }
}

function findWeeklyWindow(value: unknown): RateLimitWindow | undefined {
  if (!isRecord(value)) return undefined;

  const windows = [value.primary_window, value.secondary_window];
  for (const window of windows) {
    if (!isRecord(window)) continue;
    if (window.limit_window_seconds === WEEK_SECONDS) return window;
  }
  return undefined;
}

function parseCodexQuota(value: unknown): CodexQuota | undefined {
  if (!isRecord(value)) return undefined;

  const rateLimits: unknown[] = [value.rate_limit];
  if (Array.isArray(value.additional_rate_limits)) {
    for (const limit of value.additional_rate_limits) {
      if (isRecord(limit)) rateLimits.push(limit.rate_limit);
    }
  }

  for (const rateLimit of rateLimits) {
    const window = findWeeklyWindow(rateLimit);
    if (
      !window ||
      typeof window.used_percent !== "number" ||
      !Number.isFinite(window.used_percent)
    ) {
      continue;
    }

    const resetAtMs =
      typeof window.reset_at === "number" && Number.isFinite(window.reset_at)
        ? window.reset_at * 1000
        : typeof window.reset_after_seconds === "number" &&
            Number.isFinite(window.reset_after_seconds)
          ? Date.now() + window.reset_after_seconds * 1000
          : 0;

    return {
      remainingPercent: Math.max(0, Math.min(100, Math.round(100 - window.used_percent))),
      resetAtMs,
    };
  }

  return undefined;
}

function formatResetDuration(resetAtMs: number): string {
  const seconds = Math.max(0, Math.ceil((resetAtMs - Date.now()) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

// Module-level state to track TPS across agent runs
let agentStartMs: number | null = null;
let lastTps: number | null = null;
let totalTpsSum = 0;
let tpsCount = 0;
let footerEnabled = true;
let quotaSettings: QuotaSettings = { ...DEFAULT_QUOTA_SETTINGS };
let codexQuota: CodexQuota | undefined;
let quotaUnavailable = false;
let quotaTimer: ReturnType<typeof setInterval> | undefined;
let quotaRefresh: Promise<void> | undefined;

async function loadFooterSettings(ctx: ExtensionContext): Promise<void> {
  const settings = await getRuntimeSettings(ctx, CONFIG_DIR_NAME);
  footerEnabled = getSettingValue<boolean>(settings, FOOTER_SETTINGS_ID, "enabled") !== false;
  quotaSettings = {
    enabled:
      getSettingValue<boolean>(settings, FOOTER_SETTINGS_ID, "codexQuota.enabled") ??
      DEFAULT_QUOTA_SETTINGS.enabled,
    refreshMinutes:
      getSettingValue<number>(
        settings,
        FOOTER_SETTINGS_ID,
        "codexQuota.refreshMinutes",
      ) ?? DEFAULT_QUOTA_SETTINGS.refreshMinutes,
  };
}

async function migrateLegacyQuotaSettings(ctx: ExtensionContext): Promise<void> {
  const legacy = await readLegacyQuotaSettings();
  if (!legacy) return;

  const settings = await getRuntimeSettings(
    { cwd: ctx.cwd, isProjectTrusted: () => false },
    CONFIG_DIR_NAME,
  );
  if (settings.sources[FOOTER_SETTINGS_ID]?.["codexQuota.enabled"] === "default") {
    await updateSetting({
      scope: "global",
      cwd: ctx.cwd,
      projectTrusted: false,
      configDirName: CONFIG_DIR_NAME,
      extensionId: FOOTER_SETTINGS_ID,
      field: "codexQuota.enabled",
      value: legacy.enabled,
    });
  }
  if (
    settings.sources[FOOTER_SETTINGS_ID]?.["codexQuota.refreshMinutes"] ===
    "default"
  ) {
    await updateSetting({
      scope: "global",
      cwd: ctx.cwd,
      projectTrusted: false,
      configDirName: CONFIG_DIR_NAME,
      extensionId: FOOTER_SETTINGS_ID,
      field: "codexQuota.refreshMinutes",
      value: legacy.refreshMinutes,
    });
  }
  await unlink(LEGACY_QUOTA_SETTINGS_PATH);
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== "object") return false;
  const role = (message as { role?: unknown }).role;
  return role === "assistant";
}

export default function (pi: ExtensionAPI) {
  publishExtensionSettings(pi.events, {
    id: FOOTER_SETTINGS_ID,
    label: "Custom Stats Footer",
    description: "Controls the replacement Pi footer and optional Codex quota display.",
    fields: {
      enabled: {
        type: "boolean",
        default: true,
        label: "Enabled",
      },
      "codexQuota.enabled": {
        type: "boolean",
        default: false,
        label: "Codex quota",
      },
      "codexQuota.refreshMinutes": {
        type: "number",
        default: 5,
        label: "Refresh minutes",
        minimum: 1,
        maximum: 60,
      },
    },
  });

  // Track agent timing for TPS calculation
  pi.on("agent_start", () => {
    if (!footerEnabled) return;
    agentStartMs = Date.now();
  });

  pi.on("agent_end", (event, _ctx) => {
    if (!footerEnabled || agentStartMs === null) return;

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

  const stopQuotaUpdates = () => {
    if (quotaTimer) clearInterval(quotaTimer);
    quotaTimer = undefined;
  };

  const refreshQuota = (ctx: ExtensionContext): Promise<void> => {
    if (quotaRefresh) return quotaRefresh;

    quotaRefresh = (async () => {
      try {
        const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
        const credential = readStoredCredential("openai-codex");
        const accountId =
          credential &&
          credential.type === "oauth" &&
          typeof credential.accountId === "string"
            ? credential.accountId
            : undefined;

        if (!token || !accountId) throw new Error("OpenAI Codex login is unavailable");

        const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
          headers: {
            Authorization: `Bearer ${token}`,
            "chatgpt-account-id": accountId,
            originator: "pi",
            "User-Agent": "pi quota footer",
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Codex usage request failed (${response.status})`);

        const quota = parseCodexQuota(await response.json());
        if (!quota) throw new Error("Codex weekly limit was not present in the response");

        codexQuota = quota;
        quotaUnavailable = false;
      } catch {
        // This is an optional, undocumented endpoint: do not expose request errors or credentials.
        codexQuota = undefined;
        quotaUnavailable = true;
      } finally {
        quotaRefresh = undefined;
        // A session may shut down while this optional request is in flight.
        try {
          setupFooter(ctx);
        } catch {
          // Its context is stale; the replacement runtime owns the footer.
        }
      }
    })();

    return quotaRefresh;
  };

  const startQuotaUpdates = (ctx: ExtensionContext) => {
    stopQuotaUpdates();
    if (!quotaSettings.enabled) return;

    void refreshQuota(ctx);
    quotaTimer = setInterval(
      () => void refreshQuota(ctx),
      quotaSettings.refreshMinutes * 60 * 1000,
    );
    quotaTimer.unref?.();
  };

  // Function to set up the custom footer
  const setupFooter = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (!footerEnabled) {
      ctx.ui.setFooter(undefined);
      return;
    }

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

            // Colorize at 50% (warning) and 80% (error) context usage.
            let coloredContext: string;
            if (contextPercent >= 80) {
              coloredContext = theme.fg("error", contextStr);
            } else if (contextPercent >= 50) {
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

          if (quotaSettings.enabled) {
            if (codexQuota) {
              const fullQuota = `Codex ${codexQuota.remainingPercent}% · resets ${formatResetDuration(codexQuota.resetAtMs)}`;
              const compactQuota = `Codex ${codexQuota.remainingPercent}%`;
              const minimumPadding = 2;
              const baseStats = statsParts.join(" | ");
              const fullWidth = visibleWidth(
                [baseStats, fullQuota].filter(Boolean).join(" | "),
              );
              const quotaText =
                fullWidth + minimumPadding + visibleWidth(modelName) <= width
                  ? fullQuota
                  : compactQuota;

              if (codexQuota.remainingPercent < 20) {
                statsParts.push(theme.fg("error", quotaText));
              } else if (codexQuota.remainingPercent <= 50) {
                statsParts.push(theme.fg("warning", quotaText));
              } else {
                statsParts.push(theme.fg("success", quotaText));
              }
            } else if (quotaUnavailable) {
              statsParts.push(theme.fg("warning", "Codex unavailable"));
            }
          }

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

  // Set up custom footer and begin quota polling only after a user has opted in.
  pi.on("session_start", async (_event, ctx) => {
    await migrateLegacyQuotaSettings(ctx);
    await loadFooterSettings(ctx);
    if (!footerEnabled) {
      stopQuotaUpdates();
      codexQuota = undefined;
      quotaUnavailable = false;
    }
    setupFooter(ctx);
    startQuotaUpdates(ctx);
  });

  pi.on("session_shutdown", () => {
    stopQuotaUpdates();
  });

  // Re-assert footer when agent starts (prevents reset during agent activity)
  pi.on("agent_start", async (_event, ctx) => {
    if (footerEnabled) setupFooter(ctx);
  });
}
