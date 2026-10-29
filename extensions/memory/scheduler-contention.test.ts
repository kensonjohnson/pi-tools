import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { MemoryScheduler } from "./scheduler.ts";

test("locked state database does not block the event loop or lose durable activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "scheduler-contention-"));
  const runtime = join(root, "state"),
    sessions = join(root, "sessions");
  await mkdir(sessions);
  let locker: Database.Database | undefined;
  let scheduler: MemoryScheduler | undefined;
  try {
    let runs = 0,
      warnings = 0;
    scheduler = new MemoryScheduler({
      project: root,
      runtimeDir: runtime,
      sessionDir: sessions,
      debounceMs: 0,
      cooldownMs: 0,
      retryMs: 20,
      onStatus: () => warnings++,
      work: async () => {
        runs++;
        return { status: "done" };
      },
    });
    locker = new Database(join(runtime, "scheduler.sqlite"), { timeout: 0 });
    locker.exec("BEGIN IMMEDIATE");
    const before = Date.now();
    await assert.rejects(
      scheduler.activity(),
      /SQLITE_BUSY|database is locked/i,
    );
    assert.ok(
      Date.now() - before < 500,
      "no multi-second synchronous SQLite busy wait",
    );
    assert.ok(
      (await readdir(join(runtime, "signals"))).some((x) =>
        x.endsWith(".json"),
      ),
    );
    assert.ok(warnings > 0);
    locker.exec("ROLLBACK");
    locker.close();
    locker = undefined;
    for (let i = 0; i < 100 && runs === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runs, 1);
    assert.equal(scheduler.status().pending, 0);
  } finally {
    locker?.close();
    await scheduler?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded shutdown quarantines an abort-ignoring worker and holds the claim until it settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "scheduler-shutdown-"));
  const runtime = join(root, "state"),
    sessions = join(root, "sessions");
  await mkdir(sessions);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = false;
  let recovered = 0;
  const first = new MemoryScheduler({
    project: root,
    runtimeDir: runtime,
    sessionDir: sessions,
    debounceMs: 0,
    cooldownMs: 0,
    retryMs: 10,
    shutdownGraceMs: 25,
    work: async () => {
      active = true;
      await gate;
      return { status: "done" };
    },
  });
  let second: MemoryScheduler | undefined;
  try {
    await first.activity();
    for (let i = 0; i < 100 && !active; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(active, true);
    const before = Date.now();
    const result = await first.shutdown();
    assert.equal(result.status, "quarantined");
    assert.ok(Date.now() - before < 500);
    second = new MemoryScheduler({
      project: root,
      runtimeDir: runtime,
      sessionDir: sessions,
      debounceMs: 0,
      cooldownMs: 0,
      retryMs: 10,
      work: async () => {
        recovered++;
        return { status: "done" };
      },
    });
    assert.equal(second.status().paused, true);
    assert.throws(() => second!.resume(), /active/);
    release();
    await first.waitForIdle();
    assert.equal(second.status().paused, true);
    assert.equal(second.status().pending, 1);
    second.resume();
    for (let i = 0; i < 100 && !recovered; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(recovered, 1);
  } finally {
    release();
    await second?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
