import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import {
  estimatedTokens,
  percentage,
  type CompressionMode,
  type ObservationMetrics,
  type ToolObservationMetrics,
} from "./core.ts";
import type { StorageStats } from "./store.ts";

export type DashboardData = {
  enabled: boolean;
  mode: CompressionMode;
  eligibleTools: readonly string[];
  metrics: ObservationMetrics;
  storage?: StorageStats;
};

export function formatDashboard(data: DashboardData): string {
  const mode = data.enabled ? data.mode : "off";
  const lines = [
    "Tool Output Compression",
    `Mode: ${mode.toUpperCase()} · Token estimates use UTF-8 bytes ÷ 4`,
    "",
    "Current session",
    `  Eligible tool output       ${formatTokens(data.metrics.outputBytes)}`,
    `  Potential tokens saved     ${formatTokens(data.metrics.potentialSavedBytes)} (${formatPercent(percentage(data.metrics.potentialSavedBytes, data.metrics.outputBytes))})`,
    "  Actual tokens saved        — (exact reuse is not enabled yet)",
    "",
    "Configured tools",
    formatToolHeader(),
    ...data.eligibleTools.map((toolName) =>
      formatToolRow(toolName, data.metrics.byTool[toolName]),
    ),
    "",
    ...formatStorage(data.storage),
    "",
    "Data handling",
    data.mode === "observe" || !data.enabled
      ? "  Observe mode persists no raw output."
      : "  Apply mode remains observational until exact reuse is enabled.",
    `  Exact reuses are supporting evidence: ${data.metrics.exactReuses}.`,
  ];

  return lines.join("\n");
}

export function createDashboardComponent(
  data: DashboardData,
  theme: Theme,
  done: () => void,
) {
  return {
    render(width: number): string[] {
      const report = formatDashboard(data);
      const lines = report.split("\n");
      const styled = lines.map((line, index) => {
        if (index === 0) return theme.fg("accent", theme.bold(line));
        if (line === "Current session" || line === "Configured tools") {
          return theme.fg("accent", theme.bold(line));
        }
        if (line === "Data handling" || line === "Storage")
          return theme.fg("muted", theme.bold(line));
        if (line.startsWith("Mode:") || line.startsWith("  Metrics")) {
          return theme.fg("dim", line);
        }
        return line;
      });
      return new Text(styled.join("\n"), 1, 1).render(width);
    },
    invalidate(): void {},
    handleInput(data: string): void {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
        done();
      }
    },
  };
}

function formatStorage(storage: StorageStats | undefined): string[] {
  if (!storage) {
    return ["Storage", "  Database has not been opened in this session."];
  }
  return [
    "Storage",
    `  Database on disk          ${formatBytes(storage.databaseBytes)}`,
    `  Stored raw output         ${formatBytes(storage.storedBytes)} / ${formatBytes(storage.maxBytes)} (${storage.outputCount} outputs)`,
    `  Retention                 ${storage.retentionDays} days · ${storage.expiredCount} expired`,
    "  Maintenance               /tool-output prune · /tool-output vacuum",
  ];
}

function formatToolHeader(): string {
  return [
    pad("Tool", 18),
    pad("Output", 13),
    pad("Potential saved", 19),
    pad("Reduction", 11),
    "Reuses",
  ].join(" ");
}

function formatToolRow(
  toolName: string,
  metrics: ToolObservationMetrics | undefined,
): string {
  const value: ToolObservationMetrics = metrics ?? {
    eligibleResults: 0,
    outputBytes: 0,
    exactReuses: 0,
    potentialSavedBytes: 0,
  };
  return [
    pad(toolName, 18),
    pad(formatTokens(value.outputBytes), 13),
    pad(formatTokens(value.potentialSavedBytes), 19),
    pad(
      formatPercent(percentage(value.potentialSavedBytes, value.outputBytes)),
      11,
    ),
    String(value.exactReuses),
  ].join(" ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_024 * 1_024 * 1_024) {
    return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
  }
  return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(1)} GiB`;
}

function formatTokens(bytes: number): string {
  return `~${formatNumber(estimatedTokens(bytes))} tokens`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatNumber(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value.slice(0, width - 1) + "…"
    : value.padEnd(width);
}
