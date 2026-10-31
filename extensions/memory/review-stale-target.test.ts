import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { createTrackedReviewStore, trackReviewResults } from "./index.ts";
import { reviewAllMemories } from "./manual-review.ts";

test("repeated stale target after successful removal stops as unresolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "stale-review-"));
  const manager = new MemoryManager(root, { semanticEnabled: false });
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
    const state = { count: 0 };
    let proposals = 0;
    const reviewer = trackReviewResults(
      new MemoryReviewer({
        project: root,
        store: createTrackedReviewStore(manager, changes, state),
        model: {
          generate: async ({ instruction }: any) => {
            if (instruction.startsWith("Select")) return { paths: [] };
            if (instruction.includes("Review factual corrections"))
              return {
                action: "no_change",
                reason: "No corrections.",
                evidenceSufficient: true,
              };
            if (instruction.includes("Independently review duplicate")) {
              proposals++;
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
            }
            if (instruction.startsWith("Independently classify"))
              return {
                authority: "fact",
                noInstructionOrPreference: true,
                reason: "Descriptive fact.",
              };
            if (instruction.startsWith("Independently"))
              return {
                verdict: "supported",
                reason: "Supported.",
                fullyEntailed: true,
                noUniqueDetails: true,
                noContradiction: true,
                noExplicitInstruction: true,
              };
            throw new Error(`Unexpected instruction: ${instruction}`);
          },
        },
      }),
      changes,
      state,
    );
    const outcome = await reviewAllMemories({
      reviewer,
      signal: new AbortController().signal,
    });
    assert.equal(outcome.status, "unresolved");
    assert.equal(proposals, 2);
    assert.equal(state.count, 1);
    assert.equal(changes.length, 1);
    assert.equal(outcome.changes?.length, 1);
    assert.match(outcome.changes![0].detail, new RegExp(retained.id));
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
