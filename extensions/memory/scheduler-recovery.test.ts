import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { MemoryScheduler } from "./scheduler.ts";

test("activity spooled during state contention survives scheduler shutdown and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "scheduler-recovery-")),
    runtimeDir = join(root, "runtime"),
    sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  let a: MemoryScheduler | undefined,
    b: MemoryScheduler | undefined,
    locker: Database.Database | undefined;
  try {
    const config = {
      project: root,
      runtimeDir,
      sessionDir,
      debounceMs: 0,
      cooldownMs: 0,
      retryMs: 10,
    };
    a = new MemoryScheduler({
      ...config,
      work: async () => ({ status: "done" }),
    });
    locker = new Database(join(runtimeDir, "scheduler.sqlite"));
    locker.exec("BEGIN IMMEDIATE");
    await assert.rejects(a.activity(), /locked|SQLITE_BUSY/i);
    assert.equal(a.status().activityFlushPending, true);
    assert.ok(
      (await readdir(join(runtimeDir, "signals"))).some((x) =>
        x.endsWith(".json"),
      ),
    );
    assert.equal((await a.shutdown()).status, "closed");
    a = undefined;
    locker.exec("ROLLBACK");
    locker.close();
    locker = undefined;
    let runs = 0;
    b = new MemoryScheduler({
      ...config,
      work: async () => {
        runs++;
        return { status: "done" };
      },
    });
    b.start();
    for (let i = 0; i < 100 && !runs; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runs, 1);
    assert.equal(b.status().pending, 0);
  } finally {
    locker?.close();
    await a?.shutdown();
    await b?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
