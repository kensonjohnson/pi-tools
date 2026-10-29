import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryScheduler } from "./scheduler.ts";

test("manual full review cannot overlap an active background project claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-claim-")),
    runtimeDir = join(root, "runtime"),
    sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let running = false;
  const background = new MemoryScheduler({
    project: root,
    runtimeDir,
    sessionDir,
    debounceMs: 0,
    cooldownMs: 0,
    retryMs: 10,
    work: async () => {
      running = true;
      await gate;
      return { status: "done" };
    },
  });
  const manual = new MemoryScheduler({
    project: root,
    runtimeDir,
    sessionDir,
    automatic: false,
    work: async () => ({ status: "pending" }),
  });
  try {
    await background.activity();
    for (let i = 0; i < 100 && !running; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(running, true);
    await assert.rejects(
      manual.runManual(async () => ({ status: "done" })),
      /active/,
    );
    assert.equal(manual.cancel().mayContinue, true);
    release();
    await background.waitForIdle();
    assert.equal(manual.report().events[0].status, "uncertain");
    assert.equal(manual.status().pending, 1);
    manual.resume({ schedule: false });
    assert.equal(
      (
        await manual.runManual(async () => ({
          status: "done",
          detail: "Manual review completed.",
        }))
      ).status,
      "done",
    );
  } finally {
    release();
    await background.shutdown();
    await manual.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
