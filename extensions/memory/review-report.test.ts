import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryScheduler } from "./scheduler.ts";
import Database from "better-sqlite3";

test("reports persist bounded changes and unresolved outcomes without blocking manual retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-report-")),
    runtimeDir = join(root, "runtime"),
    sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const opts = {
    project: root,
    runtimeDir,
    sessionDir,
    automatic: false,
    work: async () => ({ status: "done" as const }),
  };
  let scheduler = new MemoryScheduler(opts);
  try {
    for (let i = 0; i < 23; i++) {
      await scheduler.runManual(async () => ({
        status: "done",
        detail: `run ${i}`,
        changes: [{ id: `id-${i}`, detail: "Changed record." }],
      }));
      await scheduler.waitForIdle();
    }
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `change-${i}`,
      detail: `Changed ${i}`,
    }));
    await scheduler.runManual(async () => ({
      status: "done",
      detail: "Many changes.",
      changes: many,
    }));
    await scheduler.waitForIdle();
    const event = scheduler.report().events[0];
    assert.equal(event.changesTotal, 20);
    assert.equal(event.changes.length, 12);
    assert.equal(event.changesOmitted, 8);
    const unresolved = await scheduler.runManual(async () => ({
      status: "unresolved",
      detail: "User instruction conflicts with code.",
      review: {
        pages: 1,
        resumedAtOffset: 0,
        memoryEvaluations: 4,
        snapshotMemories: 4,
        gapReasons: {
          no_evidence: 1,
          candidates_truncated: 2,
          secret: 99,
          model_insufficient: -1,
        } as any,
      },
    }));
    await scheduler.waitForIdle();
    assert.equal(unresolved.status, "unresolved");
    assert.equal(scheduler.status().paused, false);
    assert.equal(scheduler.report().events.length, 20);
    assert.match(scheduler.report().events[0].detail, /conflicts/);
    assert.deepEqual(scheduler.report().events[0].review?.gapReasons, {
      no_evidence: 1,
      candidates_truncated: 2,
    });
    assert.equal(scheduler.report().events[0].review?.memoryEvaluations, 4);
    await scheduler.shutdown();
    scheduler = new MemoryScheduler(opts);
    assert.equal(scheduler.status().paused, false);
    assert.equal(scheduler.report().events[0].status, "unresolved");
    assert.equal(
      scheduler.report().events[0].review?.gapReasons?.candidates_truncated,
      2,
    );
    assert.equal(
      (await scheduler.runManual(async () => ({ status: "done" }))).status,
      "done",
    );
    await scheduler.waitForIdle();
    const state = new Database(join(runtimeDir, "scheduler.sqlite"));
    state.exec("UPDATE meta SET inflight=1,status='manual-running' WHERE id=1");
    state.close();
    const interrupted = scheduler.report();
    assert.equal(interrupted.status.status, "interrupted-uncertain");
    assert.equal(interrupted.status.paused, true);
    assert.equal(interrupted.events[0].status, "uncertain");
  } finally {
    await scheduler.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
