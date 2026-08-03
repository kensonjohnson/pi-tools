import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { CodeSearchIndexFreshness } from "./worker-protocol.ts";

export type CodeSearchMetricMode = "observe" | "apply";
export type CodeSearchMetricEvent =
  | "session"
  | "validation"
  | "code_search"
  | "code_outline"
  | "code_get"
  | "code_context";

export type CodeSearchMetric = {
  mode: CodeSearchMetricMode;
  event: CodeSearchMetricEvent;
  atMs?: number;
  durationMs?: number;
  resultCount?: number;
  emittedBytes?: number;
  budgetLimited?: boolean;
  freshness?: CodeSearchIndexFreshness;
};

export type CodeSearchMetricRow = {
  day: number;
  mode: CodeSearchMetricMode;
  event: CodeSearchMetricEvent;
  calls: number;
  durationMs: number;
  resultCount: number;
  emittedBytes: number;
  budgetLimited: number;
  fresh: number;
  partial: number;
  degraded: number;
};

/** Aggregate-only local metrics; no source, query, path, or per-call records. */
export class CodeSearchMetricsStore {
  readonly #database: Database.Database;
  readonly #retentionDays: number;
  readonly #now: () => number;

  constructor(options: {
    path: string;
    retentionDays: number;
    now?: () => number;
  }) {
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.#database = new Database(options.path);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("synchronous = FULL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS daily_metrics (
        day INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('observe', 'apply')),
        event TEXT NOT NULL,
        calls INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        result_count INTEGER NOT NULL,
        emitted_bytes INTEGER NOT NULL,
        budget_limited INTEGER NOT NULL,
        fresh INTEGER NOT NULL,
        partial INTEGER NOT NULL,
        degraded INTEGER NOT NULL,
        PRIMARY KEY (day, mode, event)
      );
    `);
    chmodSafe(options.path);
    chmodSafe(`${options.path}-wal`);
    chmodSafe(`${options.path}-shm`);
    this.#retentionDays = Math.max(1, Math.floor(options.retentionDays));
    this.#now = options.now ?? Date.now;
  }

  record(metric: CodeSearchMetric): void {
    const day = dayStart(metric.atMs ?? this.#now());
    const freshness = metric.freshness;
    this.#database
      .prepare(
        `
        INSERT INTO daily_metrics (
          day, mode, event, calls, duration_ms, result_count, emitted_bytes,
          budget_limited, fresh, partial, degraded
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, mode, event) DO UPDATE SET
          calls = calls + 1,
          duration_ms = duration_ms + excluded.duration_ms,
          result_count = result_count + excluded.result_count,
          emitted_bytes = emitted_bytes + excluded.emitted_bytes,
          budget_limited = budget_limited + excluded.budget_limited,
          fresh = fresh + excluded.fresh,
          partial = partial + excluded.partial,
          degraded = degraded + excluded.degraded
      `,
      )
      .run(
        day,
        metric.mode,
        metric.event,
        nonNegative(metric.durationMs),
        nonNegative(metric.resultCount),
        nonNegative(metric.emittedBytes),
        metric.budgetLimited ? 1 : 0,
        freshness === "fresh" ? 1 : 0,
        freshness === "partial" ? 1 : 0,
        freshness === "degraded" ? 1 : 0,
      );
    this.prune(metric.atMs ?? this.#now());
  }

  rows(): CodeSearchMetricRow[] {
    return this.#database
      .prepare(
        `SELECT day, mode, event, calls, duration_ms, result_count,
                emitted_bytes, budget_limited, fresh, partial, degraded
         FROM daily_metrics ORDER BY day, mode, event`,
      )
      .all()
      .map((row) => {
        const value = row as {
          day: number;
          mode: CodeSearchMetricMode;
          event: CodeSearchMetricEvent;
          calls: number;
          duration_ms: number;
          result_count: number;
          emitted_bytes: number;
          budget_limited: number;
          fresh: number;
          partial: number;
          degraded: number;
        };
        return {
          day: value.day,
          mode: value.mode,
          event: value.event,
          calls: value.calls,
          durationMs: value.duration_ms,
          resultCount: value.result_count,
          emittedBytes: value.emitted_bytes,
          budgetLimited: value.budget_limited,
          fresh: value.fresh,
          partial: value.partial,
          degraded: value.degraded,
        };
      });
  }

  prune(now = this.#now()): number {
    const result = this.#database
      .prepare("DELETE FROM daily_metrics WHERE day < ?")
      .run(dayStart(now) - (this.#retentionDays - 1) * 86_400_000);
    return result.changes;
  }

  close(): void {
    this.#database.close();
  }
}

function dayStart(atMs: number): number {
  const date = new Date(atMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value ?? 0)) : 0;
}

function chmodSafe(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX permission bits.
  }
}
