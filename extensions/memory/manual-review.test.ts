import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryScheduler } from "./scheduler.ts";
import { reviewAllMemories } from "./manual-review.ts";

async function fixture(
  fn: (root: string, runtimeDir: string, sessionDir: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "manual-review-"));
  const runtimeDir = join(root, "runtime"),
    sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  try {
    await fn(root, runtimeDir, sessionDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("manual full review follows pages and restarts after a mutation", async () => {
  const offsets: Array<number | undefined> = [];
  let i = 0;
  const reviewer: any = {
    review: async ({ fullOffset }: any) => {
      offsets.push(fullOffset);
      return ++i === 1
        ? { status: "applied", memoryId: "id", detail: "Updated." }
        : i === 2
          ? { status: "unchanged", nextOffset: 50, fullSnapshot: "hash" }
          : { status: "unchanged", detail: "No supported changes proposed." };
    },
  };
  const result = await reviewAllMemories({
    reviewer,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "done");
  assert.equal(result.changes?.length, 1);
  assert.deepEqual(offsets, [undefined, undefined, 50]);
});
test("full review exposes bounded continuation without silently restarting", async () => {
  const offsets: Array<number | undefined> = [];
  const reviewer: any = {
    review: async ({ fullOffset }: any) => {
      offsets.push(fullOffset);
      return fullOffset === undefined
        ? { status: "unchanged", nextOffset: 50, fullSnapshot: "hash" }
        : { status: "unchanged", detail: "No supported changes proposed." };
    },
  };
  const first = await reviewAllMemories({
    reviewer,
    signal: new AbortController().signal,
    maxPasses: 1,
  });
  assert.equal(first.status, "pending");
  assert.equal(first.nextOffset, 50);
  assert.equal(first.fullSnapshot, "hash");
  const next = await reviewAllMemories({
    reviewer,
    signal: new AbortController().signal,
    fullOffset: first.nextOffset,
    fullSnapshot: first.fullSnapshot,
  });
  assert.equal(next.status, "done");
  assert.deepEqual(offsets, [undefined, 50]);
});
test("failure after a partial apply is uncertain, not automatically retried", async () => {
  let i = 0;
  const reviewer: any = {
    review: async () => {
      if (++i === 1)
        return { status: "applied", memoryId: "id", detail: "Updated." };
      throw new Error("model unavailable");
    },
  };
  const result = await reviewAllMemories({
    reviewer,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "uncertain");
  assert.equal(result.changes?.length, 1);
  assert.equal(i, 2);
});
test("manual and background work share one claim; cancel remains uncertain and report persists", () =>
  fixture(async (root, runtimeDir, sessionDir) => {
    const options = {
      project: root,
      runtimeDir,
      sessionDir,
      automatic: false,
      work: async () => ({ status: "done" as const }),
    };
    const a = new MemoryScheduler(options),
      b = new MemoryScheduler(options);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const running = a.runManual(async () => {
        await gate;
        return { status: "done", detail: "Done." };
      });
      await assert.rejects(
        b.runManual(async () => ({ status: "done" })),
        /active/,
      );
      assert.equal(a.cancel().mayContinue, true);
      assert.equal(a.status().inflight, true);
      release();
      assert.equal((await running).status, "uncertain");
      assert.equal(a.status().paused, true);
      assert.equal(b.report().events[0].status, "uncertain");
      assert.match(b.report().events[0].detail, /inspect/i);
      b.resume({ schedule: false });
      assert.equal(b.status().paused, false);
    } finally {
      release();
      await a.shutdown();
      await b.shutdown();
    }
  }));
