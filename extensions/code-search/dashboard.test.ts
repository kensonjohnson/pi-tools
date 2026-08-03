import assert from "node:assert/strict";
import test from "node:test";
import { formatCodeSearchDashboard } from "./dashboard.ts";

test("code-search dashboard labels aggregates without counterfactual savings", () => {
  const dashboard = formatCodeSearchDashboard({
    mode: "apply",
    retentionDays: 90,
    rows: [
      {
        day: 0,
        mode: "observe",
        event: "session",
        calls: 1,
        durationMs: 2,
        resultCount: 0,
        emittedBytes: 0,
        budgetLimited: 0,
        fresh: 1,
        partial: 0,
        degraded: 0,
      },
      {
        day: 0,
        mode: "apply",
        event: "code_search",
        calls: 2,
        durationMs: 9,
        resultCount: 3,
        emittedBytes: 128,
        budgetLimited: 1,
        fresh: 2,
        partial: 0,
        degraded: 0,
      },
    ],
  });
  assert.match(dashboard, /Observed opportunity \(not emitted output\)/);
  assert.match(dashboard, /Structural estimate \(not a savings claim\)/);
  assert.match(dashboard, /Actual emitted output \(apply mode\)/);
  assert.match(
    dashboard,
    /no source, query, path, per-call record, or network telemetry/i,
  );
  assert.doesNotMatch(dashboard, /potential savings/i);
});
