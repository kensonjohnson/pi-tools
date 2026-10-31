import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { createTrackedReviewStore, trackReviewResults } from "./index.ts";
import { MemoryScheduler } from "./scheduler.ts";
import { reviewAllMemories } from "./manual-review.ts";

const supported = {
  verdict: "supported",
  reason: "Supported.",
  fullyEntailed: true,
  noUniqueDetails: true,
  noContradiction: true,
  noExplicitInstruction: true,
};

test("tracked semantic removal records target and retained source in persisted review", async () => {
  const root = await mkdtemp(join(tmpdir(), "tracked-dedup-"));
  const manager = new MemoryManager(root, { semanticEnabled: false });
  const sessions = join(root, "sessions");
  await mkdir(sessions);
  const scheduler = new MemoryScheduler({
    project: root,
    runtimeDir: join(root, "runtime"),
    sessionDir: sessions,
    automatic: false,
    work: async () => ({ status: "done" }),
  });
  try {
    await manager.init();
    const target = (
      await manager.remember(
        "knowledge",
        "The project uses pnpm for package management.",
      )
    ).memory;
    const retained = (
      await manager.remember(
        "knowledge",
        "The project package manager is pnpm.",
      )
    ).memory;
    const changes: Array<{ id: string; detail: string }> = [];
    let proposed = false;
    const reviewer = trackReviewResults(
      new MemoryReviewer({
        project: root,
        store: createTrackedReviewStore(manager, changes),
        model: {
          generate: async ({ instruction }: any) => {
            if (instruction.startsWith("Select")) return { paths: [] };
            if (instruction.startsWith("Independently classify"))
              return {
                authority: "fact",
                noInstructionOrPreference: true,
                reason: "Descriptive fact.",
              };
            if (instruction.startsWith("Independently")) return supported;
            if (proposed)
              return {
                action: "no_change",
                reason: "Reviewed.",
                evidenceSufficient: true,
              };
            proposed = true;
            return {
              action: "remove",
              id: target.id,
              targetAuthority: "fact",
              reason: "Redundant.",
              citation: {
                kind: "memory",
                id: retained.id,
                quote: retained.content,
              },
            };
          },
        },
      }),
      changes,
    );
    const outcome = await scheduler.runManual(async (signal) => {
      const result = await reviewAllMemories({ reviewer, signal });
      return { ...result, changes };
    });
    assert.equal(outcome.status, "unresolved");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].id, target.id);
    assert.match(
      changes[0].detail,
      new RegExp(`retained memory ID: ${retained.id}`),
    );
    assert.deepEqual(
      (await manager.list()).memories.map((m) => m.id),
      [retained.id],
    );
    assert.match(
      scheduler.report().events[0].changes[0].detail,
      new RegExp(retained.id),
    );
  } finally {
    await scheduler.shutdown();
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("tracked snapshot removal does not record a failed guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "tracked-guard-"));
  const manager = new MemoryManager(root, { semanticEnabled: false });
  try {
    await manager.init();
    const target = (await manager.remember("knowledge", "Target fact.")).memory;
    const source = (await manager.remember("knowledge", "Source fact.")).memory;
    const changes: Array<{ id: string; detail: string }> = [];
    const store = createTrackedReviewStore(manager, changes);
    const snapshot = await store.captureAddPrecondition();
    const precondition = (await manager.captureWritePrecondition(target.id))!;
    await manager.update(source.id, "Updated source.");
    await assert.rejects(
      store.forgetWithSnapshot(target.id, precondition, snapshot),
    );
    assert.deepEqual(changes, []);
    assert.ok((await manager.list()).memories.some((m) => m.id === target.id));
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
