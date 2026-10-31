import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewAllMemories } from "./manual-review.ts";
import { reviewResultChanges } from "./scheduler.ts";
import { trackReviewResults } from "./index.ts";

test("generic partial semantic batches retain source IDs and stop on no progress", async () => {
  let calls = 0;
  const outcome = await reviewAllMemories({
    signal: new AbortController().signal,
    reviewer: {
      review: async () =>
        ++calls === 1
          ? {
              status: "unresolved",
              acknowledged: false,
              detail: "partial",
              unresolvedProposals: 1,
              changes: [
                {
                  action: "remove",
                  memoryId: "removed",
                  retainedMemoryId: "retained",
                },
              ],
            }
          : {
              status: "unresolved",
              acknowledged: false,
              detail: "no progress",
            },
    } as any,
  });
  assert.equal(calls, 2);
  assert.equal(outcome.status, "unresolved");
  assert.deepEqual(outcome.changes, [
    { id: "removed", detail: "remove applied; retained memory ID: retained" },
  ]);
  assert.deepEqual(
    reviewResultChanges({
      status: "applied",
      acknowledged: false,
      detail: "applied",
      memoryId: "removed",
      retainedMemoryId: "unsafe\nsecret",
    }),
    [{ id: "removed", detail: "applied" }],
  );
});

test("tracked review only classifies stale target errors before any dispatched write", async () => {
  for (const dispatched of [false, true]) {
    const state = { count: 0 };
    const changes: Array<{ id: string; detail: string }> = [];
    const reviewer = trackReviewResults(
      {
        review: async () => {
          if (dispatched) state.count++;
          throw new Error("unknown memory target");
        },
      } as any,
      changes,
      state,
    );
    if (dispatched)
      await assert.rejects(reviewer.review(), /unknown memory target/);
    else assert.equal((await reviewer.review()).status, "unresolved");
  }
});

test("stale target after a confirmed pass does not cause uncertain or replay", async () => {
  const state = { count: 0 };
  const changes: Array<{ id: string; detail: string }> = [];
  let calls = 0;
  const reviewer = trackReviewResults(
    {
      review: async () => {
        calls++;
        if (calls === 1) {
          state.count++;
          return {
            status: "unresolved",
            acknowledged: false,
            detail: "partial",
            changes: [
              {
                action: "remove",
                memoryId: "removed",
                retainedMemoryId: "retained",
              },
            ],
          };
        }
        throw new Error("unknown memory target");
      },
    } as any,
    changes,
    state,
  );
  const outcome = await reviewAllMemories({
    reviewer,
    signal: new AbortController().signal,
  });
  assert.equal(calls, 2);
  assert.equal(state.count, 1);
  assert.equal(outcome.status, "unresolved");
  assert.match(outcome.changes![0].detail, /retained memory ID: retained/);
});
