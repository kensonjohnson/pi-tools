import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reviewAllMemories } from "./manual-review.ts";
import { MemoryScheduler, reviewProjectSessions } from "./scheduler.ts";
import { formatReviewStatus } from "./index.ts";

const batchChanges = [
  { action: "add", memoryId: "one" },
  { action: "update", memoryId: "two" },
] as const;

test("manual partial batch records all changes and clears continuation", async () => {
  let cleared = false;
  let calls = 0;
  const result = await reviewAllMemories({
    reviewer: {
      review: async () =>
        ++calls === 1
          ? {
              status: "unresolved",
              detail: "partial",
              acknowledged: false,
              changes: batchChanges,
              unresolvedProposals: 2,
              unresolvedTargets: [
                "target-1",
                "target-1",
                "private model text\nsecret",
              ],
            }
          : {
              status: "unresolved",
              detail: "no progress",
              acknowledged: false,
            },
    } as any,
    signal: new AbortController().signal,
    fullOffset: 50,
    fullSnapshot: "hash",
    onProgress: (cursor) => {
      if (!cursor) cleared = true;
    },
  });
  assert.equal(result.status, "unresolved");
  assert.deepEqual(
    result.changes?.map((x) => x.id),
    ["one", "two"],
  );
  assert.equal(cleared, true);
  assert.equal(calls, 2);
  assert.deepEqual(result.unresolved, {
    proposals: 2,
    targets: ["target-1"],
    targetsOmitted: 0,
  });
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("unresolved proposals prevent a false done even on an applied result", async () => {
  let calls = 0;
  const result = await reviewAllMemories({
    reviewer: {
      review: async () => {
        calls++;
        return {
          status: calls === 1 ? "applied" : "unresolved",
          acknowledged: false,
          detail: "applied",
          changes: calls === 1 ? batchChanges : [],
          unresolvedProposals: 1,
          unresolvedTargets: ["target-2"],
        };
      },
    } as any,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "unresolved");
  assert.equal(calls, 2);
  assert.equal(result.changes?.length, 2);
  assert.equal(result.unresolved?.proposals, 1);
});

test("manual cancellation after a batch reports changes without another review", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await reviewAllMemories({
    reviewer: {
      review: async () => {
        calls++;
        controller.abort();
        return {
          status: "applied",
          acknowledged: false,
          detail: "applied",
          changes: batchChanges,
        };
      },
    } as any,
    signal: controller.signal,
  });
  assert.equal(result.status, "uncertain");
  assert.equal(calls, 1);
  assert.equal(result.changes?.length, 2);
});

test("background partial batch reports changes and does not acknowledge or replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-batch-progress-"));
  try {
    const sessions = join(root, "sessions");
    await mkdir(sessions);
    await writeFile(
      join(sessions, "one.jsonl"),
      [
        { type: "session", version: 3, id: "s", cwd: root },
        {
          type: "message",
          id: "a",
          parentId: null,
          message: { role: "user", content: "hello" },
        },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    let calls = 0;
    const result = await reviewProjectSessions({
      project: root,
      sessionDir: sessions,
      checkpointFile: join(root, "runtime", "progress.json"),
      reviewer: {
        review: async () => {
          calls++;
          return {
            status: "uncertain",
            detail: "partial",
            acknowledged: false,
            changes: batchChanges,
            unresolvedProposals: 3,
            unresolvedTargets: Array.from(
              { length: 15 },
              (_, i) => `target-${i}`,
            ),
          };
        },
      } as any,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, "uncertain");
    assert.equal(calls, 1);
    assert.deepEqual(
      result.changes?.map((x) => x.id),
      ["one", "two"],
    );
    assert.equal(result.unresolved?.proposals, 3);
    assert.equal(result.unresolved?.targets.length, 12);
    assert.equal(result.unresolved?.targetsOmitted, 3);
    const options = {
      project: root,
      runtimeDir: join(root, "report"),
      sessionDir: sessions,
      automatic: false,
      work: async () => ({ status: "done" as const }),
    };
    let scheduler = new MemoryScheduler(options);
    const many = Array.from({ length: 15 }, (_, i) => ({
      id: String(i),
      detail: "applied",
    }));
    await scheduler.runManual(async () => ({
      status: "uncertain",
      changes: many,
      unresolved: result.unresolved,
    }));
    const event = scheduler.report().events[0];
    assert.equal(event.changesTotal, 15);
    assert.equal(event.changesOmitted, 3);
    await scheduler.shutdown();
    scheduler = new MemoryScheduler(options);
    const report = scheduler.report();
    assert.deepEqual(report.events[0].unresolved, result.unresolved);
    const text = formatReviewStatus({
      ...report,
      configuredModel: null,
      historyEnabled: false,
    });
    assert.match(text, /3 unresolved proposal\(s\)/);
    assert.match(text, /target-0/);
    assert.match(text, /3 target ID\(s\) omitted/);
    await scheduler.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
