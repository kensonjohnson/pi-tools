import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { MemoryScheduler } from "./scheduler.ts";

test("pre-existing review report database upgrades without dropping older events", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-migrate-")),
    runtimeDir = join(root, "state"),
    sessionDir = join(root, "sessions");
  await mkdir(runtimeDir);
  await mkdir(sessionDir);
  try {
    const db = new Database(join(runtimeDir, "scheduler.sqlite"));
    db.exec(
      "CREATE TABLE review_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, changes TEXT NOT NULL)",
    );
    db.prepare(
      "INSERT INTO review_events(at,mode,status,detail,changes) VALUES(?,?,?,?,?)",
    ).run(
      1,
      "manual",
      "done",
      "old",
      JSON.stringify([{ id: "x", detail: "old change" }]),
    );
    db.close();
    const scheduler = new MemoryScheduler({
      project: root,
      runtimeDir,
      sessionDir,
      automatic: false,
      work: async () => ({ status: "done" }),
    });
    try {
      const event = scheduler.report().events[0];
      assert.equal(event.detail, "old");
      assert.equal(event.changesTotal, 1);
      assert.equal(event.changesOmitted, 0);
    } finally {
      await scheduler.shutdown();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
