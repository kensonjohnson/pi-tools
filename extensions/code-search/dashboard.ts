import type { CodeSearchMetricRow } from "./metrics.ts";
import type { CodeSearchMode } from "./settings.ts";
import type { CodeSearchWorkerStatus } from "./worker-protocol.ts";

export function formatCodeSearchDashboard(data: {
  mode: CodeSearchMode;
  retentionDays: number;
  rows: readonly CodeSearchMetricRow[];
  status?: CodeSearchWorkerStatus;
}): string {
  const rows = data.rows;
  const calls = sum(rows, "calls");
  const emittedBytes = sum(rows, "emittedBytes");
  const resultCount = sum(rows, "resultCount");
  const durationMs = sum(rows, "durationMs");
  const observed = rows.filter((row) => row.mode === "observe");
  const delivered = rows.filter((row) => row.mode === "apply");
  const lines = [
    "Code Search",
    `Mode: ${data.mode.toUpperCase()} · Aggregate-only local metrics · ${data.retentionDays}-day retention`,
    "",
    "Index",
    data.status
      ? `  Freshness: ${data.status.freshness} · indexed ${data.status.coverage.indexedFiles} · parse errors ${data.status.coverage.parseErrors}`
      : "  Not initialized in this session.",
    "",
    "Observed opportunity (not emitted output)",
    `  Events ${sum(observed, "calls")} · validations/index activity only`,
    "  No counterfactual token-savings claim is calculated.",
    "",
    "Structural estimate (not a savings claim)",
    `  Indexed result references ${resultCount} · budget-limited responses ${sum(rows, "budgetLimited")}`,
    "",
    "Actual emitted output (apply mode)",
    `  Tool calls ${sum(delivered, "calls")} · ${emittedBytes} bytes · ${resultCount} results · ${durationMs} ms total`,
    "",
    "Data handling",
    "  Stores daily aggregates only: no source, query, path, per-call record, or network telemetry.",
    "  Maintenance: /code-search prune",
  ];
  return lines.join("\n");
}

function sum(
  rows: readonly CodeSearchMetricRow[],
  field:
    "calls" | "durationMs" | "resultCount" | "emittedBytes" | "budgetLimited",
): number {
  return rows.reduce((total, row) => total + row[field], 0);
}
