import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewAllMemories } from "./manual-review.ts";

test("partial writes restart at zero until a clean traversal finishes", async () => {
  const offsets: unknown[] = [];
  const progress: unknown[] = [];
  let calls = 0;
  const result = await reviewAllMemories({
    fullOffset: 20,
    fullSnapshot: "old",
    priorEvidenceGaps: true,
    signal: new AbortController().signal,
    onProgress: (cursor) => progress.push(cursor),
    reviewer: {
      review: async ({ fullOffset }: any) => {
        offsets.push(fullOffset);
        calls++;
        if (calls <= 2)
          return {
            status: "unresolved",
            acknowledged: false,
            detail: "partial",
            changes: [{ action: "remove", memoryId: `id-${calls}` }],
            unresolvedProposals: 1,
            unresolvedTargets: [`target-${calls}`],
            audit: {
              coverage: "insufficient",
              gapReasons: ["fragment_insufficient"],
            },
          };
        if (calls === 3)
          return {
            status: "unchanged",
            acknowledged: false,
            nextOffset: 10,
            fullSnapshot: "fresh",
            audit: { coverage: "limited" },
          };
        return {
          status: "unchanged",
          acknowledged: false,
          detail: "limited",
          audit: { coverage: "limited" },
        };
      },
    } as any,
  });
  assert.equal(result.status, "done");
  assert.deepEqual(offsets, [20, undefined, undefined, 10]);
  assert.deepEqual(
    result.changes?.map((x) => x.id),
    ["id-1", "id-2"],
  );
  assert.equal(result.unresolved, undefined);
  assert.equal(result.review?.evidenceGaps, 2);
  assert.deepEqual(progress, [
    undefined,
    undefined,
    { offset: 10, snapshot: "fresh", evidenceGaps: false },
    undefined,
  ]);
});

test("partial progress stops on unchanged unresolved and retains latest target", async () => {
  let calls = 0;
  const result = await reviewAllMemories({
    signal: new AbortController().signal,
    reviewer: {
      review: async () => {
        calls++;
        return {
          status: "unresolved",
          acknowledged: false,
          detail: "partial",
          changes:
            calls < 3 ? [{ action: "update", memoryId: `id-${calls}` }] : [],
          unresolvedProposals: calls,
          unresolvedTargets: [`target-${calls}`],
        };
      },
    } as any,
  });
  assert.equal(calls, 3);
  assert.equal(result.status, "unresolved");
  assert.equal(result.changes?.length, 2);
  assert.deepEqual(result.unresolved, {
    proposals: 3,
    targets: ["target-3"],
    targetsOmitted: 0,
  });
});

test("pass limit retains unresolved details and uncertain writes are not retried", async () => {
  for (const status of ["unresolved", "uncertain"] as const) {
    let calls = 0;
    const result = await reviewAllMemories({
      signal: new AbortController().signal,
      maxPasses: 1,
      reviewer: {
        review: async () => {
          calls++;
          return {
            status,
            acknowledged: false,
            detail: "partial",
            changes: [{ action: "remove", memoryId: "id" }],
            unresolvedProposals: 1,
            unresolvedTargets: ["target"],
          };
        },
      } as any,
    });
    assert.equal(calls, 1);
    assert.equal(
      result.status,
      status === "uncertain" ? "uncertain" : "pending",
    );
    assert.equal(result.unresolved?.proposals, 1);
    assert.equal(result.changes?.length, 1);
  }
});
