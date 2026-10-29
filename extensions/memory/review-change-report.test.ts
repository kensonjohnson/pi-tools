import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { createTrackedReviewStore } from "./index.ts";

test("review reports identify actual added, updated, moved and removed memories", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-change-"));
  const manager = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await manager.init();
    const changes: Array<{ id: string; detail: string }> = [];
    const store = createTrackedReviewStore(manager, changes);
    const added = await store.remember(
      "knowledge",
      "Queue data persists.",
      await store.captureAddPrecondition(),
    );
    await store.update(
      added.memory.id,
      "Queue data persists on disk.",
      (await manager.captureWritePrecondition(added.memory.id))!,
    );
    await store.move(
      (await manager.captureMovePrecondition(added.memory.id))!,
      "practices",
    );
    await store.forget(
      added.memory.id,
      (await manager.captureWritePrecondition(added.memory.id))!,
    );
    assert.equal(changes.length, 4);
    assert.match(changes[0].detail, /Added \[knowledge\].*Queue/);
    assert.match(changes[1].detail, /Updated.*disk/);
    assert.match(changes[2].detail, /Moved \[knowledge -> practices\]/);
    assert.match(changes[3].detail, /Removed \[practices\]/);
  } finally {
    await manager.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
