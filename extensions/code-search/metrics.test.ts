import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodeSearchMetricsStore } from "./metrics.ts";

const DAY = 86_400_000;

test("code-search metrics retain aggregate rows only and prune by day", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-code-search-metrics-"));
  const today = Date.UTC(2026, 0, 3);
  const now = today + 12 * 60 * 60 * 1_000;
  const path = join(root, ".pi", "code-search", "metrics.sqlite");
  const store = new CodeSearchMetricsStore({
    path,
    retentionDays: 2,
    now: () => now,
  });
  try {
    store.record({
      mode: "observe",
      event: "validation",
      atMs: now - DAY,
      durationMs: 12,
      freshness: "fresh",
    });
    store.record({
      mode: "observe",
      event: "validation",
      atMs: now - DAY,
      durationMs: 8,
      freshness: "partial",
    });
    store.record({
      mode: "apply",
      event: "code_search",
      atMs: now,
      durationMs: 3,
      resultCount: 4,
      emittedBytes: 320,
      budgetLimited: true,
      freshness: "degraded",
    });
    assert.deepEqual(store.rows(), [
      {
        day: today - DAY,
        mode: "observe",
        event: "validation",
        calls: 2,
        durationMs: 20,
        resultCount: 0,
        emittedBytes: 0,
        budgetLimited: 0,
        fresh: 1,
        partial: 1,
        degraded: 0,
      },
      {
        day: today,
        mode: "apply",
        event: "code_search",
        calls: 1,
        durationMs: 3,
        resultCount: 4,
        emittedBytes: 320,
        budgetLimited: 1,
        fresh: 0,
        partial: 0,
        degraded: 1,
      },
    ]);
    store.record({ mode: "observe", event: "session", atMs: now + DAY });
    assert.deepEqual(
      store.rows().map((row) => row.day),
      [today, today + DAY],
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
