import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import {
  estimatedTokens,
  percentage,
  type CompressionMode,
  type ObservationMetrics,
  type ProfileObservationMetrics,
  type ToolObservationMetrics,
} from "./core.ts";
import type { StorageStats } from "./store.ts";

export type DashboardProfile = {
  id: string;
  label: string;
  mode: CompressionMode;
};

export type DashboardData = {
  enabled: boolean;
  mode: CompressionMode;
  eligibleTools: readonly string[];
  profiles: readonly DashboardProfile[];
  metrics: ObservationMetrics;
  storage?: StorageStats;
};

export function formatDashboard(data: DashboardData): string {
  const mode = data.enabled ? data.mode : "off";
  const appliesReuse = data.enabled && data.mode === "apply";
  const lines = [
    "Tool Output Compression",
    `Mode: ${mode.toUpperCase()} · Token estimates use UTF-8 bytes ÷ 4`,
    "",
    "Current session",
    `  Eligible tool output       ${formatTokens(data.metrics.outputBytes)}`,
    `  Potential tokens saved     ${formatTokens(data.metrics.potentialSavedBytes)} (${formatPercent(percentage(data.metrics.potentialSavedBytes, data.metrics.outputBytes))})`,
    appliesReuse
      ? `  Actual tokens saved        ${formatTokens(data.metrics.actualSavedBytes)} (${formatPercent(percentage(data.metrics.actualSavedBytes, data.metrics.outputBytes))})`
      : "  Actual tokens saved        — (observe mode)",
    "",
    "Configured tools",
    formatToolHeader(appliesReuse),
    ...data.eligibleTools.map((toolName) =>
      formatToolRow(toolName, data.metrics.byTool[toolName], appliesReuse),
    ),
    "",
    ...formatProfiles(data),
    "",
    ...formatStorage(data.storage),
    "",
    "Data handling",
    data.mode === "observe" || !data.enabled
      ? "  Observe mode persists no raw output."
      : "  Apply mode stores an original before replacing output.",
    appliesReuse
      ? `  Exact duplicates reused: ${data.metrics.appliedReuses}.`
      : `  Exact reuses are supporting evidence: ${data.metrics.exactReuses}.`,
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
        if (
          line === "Current session" ||
          line === "Configured tools" ||
          line === "Profiles"
        ) {
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

function formatProfiles(data: DashboardData): string[] {
  const lines = ["Profiles"];
  for (const profile of data.profiles) {
    const metrics = data.metrics.profiles[profile.id] ?? emptyProfileMetrics();
    const applies =
      data.enabled && data.mode === "apply" && profile.mode === "apply";
    const savedBytes = applies
      ? metrics.actualSavedBytes
      : metrics.potentialSavedBytes;
    lines.push(
      `  ${profile.label} (${profile.mode.toUpperCase()}) · ${metrics.candidates} candidates · ${formatTokens(savedBytes)} ${applies ? "actual" : "potential"} savings`,
      `    Raw / visible / compact ${formatBytes(metrics.rawBytes)} / ${formatBytes(metrics.visibleBytes)} / ${formatBytes(metrics.projectedCompactBytes)} · ${metrics.recoveredFullOutput} full recoveries`,
      `    Summary ${formatSummary(metrics.summary)} · Bypasses ${formatBypasses(metrics.bypasses)}`,
    );
  }
  return lines;
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

function formatToolHeader(appliesReuse: boolean): string {
  return [
    pad("Tool", 18),
    pad("Output", 13),
    pad(appliesReuse ? "Actual saved" : "Potential saved", 19),
    pad("Reduction", 11),
    "Reuses",
  ].join(" ");
}

function formatToolRow(
  toolName: string,
  metrics: ToolObservationMetrics | undefined,
  appliesReuse: boolean,
): string {
  const value: ToolObservationMetrics = metrics ?? {
    eligibleResults: 0,
    outputBytes: 0,
    exactReuses: 0,
    potentialSavedBytes: 0,
    appliedReuses: 0,
    actualSavedBytes: 0,
  };
  const savedBytes = appliesReuse
    ? value.actualSavedBytes
    : value.potentialSavedBytes;
  const reuseCount = appliesReuse ? value.appliedReuses : value.exactReuses;
  return [
    pad(toolName, 18),
    pad(formatTokens(value.outputBytes), 13),
    pad(formatTokens(savedBytes), 19),
    pad(formatPercent(percentage(savedBytes, value.outputBytes)), 11),
    String(reuseCount),
  ].join(" ");
}

function emptyProfileMetrics(): ProfileObservationMetrics {
  return {
    candidates: 0,
    applied: 0,
    visibleBytes: 0,
    rawBytes: 0,
    projectedCompactBytes: 0,
    potentialSavedBytes: 0,
    actualSavedBytes: 0,
    recoveredFullOutput: 0,
    summary: {},
    bypasses: {},
  };
}

function formatSummary(summary: Record<string, number>): string {
  const entries = Object.entries(summary);
  return entries.length === 0
    ? "none"
    : entries.map(([name, value]) => `${name}: ${value}`).join(", ");
}

function formatBypasses(bypasses: Record<string, number>): string {
  const entries = Object.entries(bypasses);
  return entries.length === 0
    ? "none"
    : entries.map(([reason, count]) => `${reason}: ${count}`).join(", ");
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
