import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionReview } from "./session-review.ts";
import { validateSessionBatch } from "./reviewer-session.ts";

test("oversized Unicode message resumes by byte range and validates each chunk", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-chunks-"));
  const dir = join(root, "sessions");
  mkdirSync(dir);
  const path = join(dir, "one.jsonl");
  const text = '🙂é"\\\n'.repeat(100);
  const header = { type: "session", version: 3, id: "s", cwd: root };
  const entry = {
    type: "message",
    id: "m",
    parentId: null,
    message: { role: "user", content: text },
  };
  writeFileSync(path, [header, entry].map(JSON.stringify).join("\n") + "\n");
  const make = () =>
    new SessionReview({
      project: root,
      sessionDir: dir,
      checkpointFile: join(root, "checkpoint"),
      maxTextBytes: 150,
    });
  try {
    let rebuilt = "",
      offset = 0,
      count = 0;
    while (true) {
      const review = make();
      const batch = review.discover().batches[0];
      assert.ok(batch);
      assert.equal(batch.items.length, 1);
      const item = batch.items[0];
      assert.equal(item.id, "m");
      assert.equal(item.role, "user");
      assert.equal(item.chunk?.start, offset);
      assert.equal(item.chunk?.total, Buffer.byteLength(text));
      assert.equal(item.chunk?.end, offset + Buffer.byteLength(item.text));
      await validateSessionBatch(root, batch);
      if (count === 0) {
        const resumed = make();
        const repeated = resumed.discover({
          boundaries: new Map([[path, batch.sourceBoundary!]]),
        }).batches[0];
        assert.equal(repeated.resumedBoundary, true);
        assert.deepEqual(repeated.items, batch.items);
        resumed.close();
      }
      const altered = { ...batch, items: [{ ...item, text: item.text + "x" }] };
      await assert.rejects(validateSessionBatch(root, altered));
      rebuilt += item.text;
      offset = item.chunk!.end;
      count++;
      batch.acknowledge();
      review.close();
      if (!batch.more) break;
      assert.ok(count < 100);
    }
    assert.equal(rebuilt, text);
    const review = make();
    assert.equal(review.discover().batches.length, 0);
    review.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale scheduler boundary after chunk acknowledgement resumes at the next byte", () => {
  const root = mkdtempSync(join(tmpdir(), "session-crash-"));
  const dir = join(root, "sessions");
  mkdirSync(dir);
  const path = join(dir, "one.jsonl");
  const text = "🙂hello".repeat(80);
  writeFileSync(
    path,
    [
      { type: "session", version: 3, id: "s", cwd: root },
      {
        type: "message",
        id: "m",
        parentId: null,
        message: { role: "user", content: text },
      },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  const make = () =>
    new SessionReview({
      project: root,
      sessionDir: dir,
      checkpointFile: join(root, "checkpoint"),
      maxTextBytes: 150,
    });
  try {
    const firstReview = make();
    const first = firstReview.discover().batches[0];
    const boundary = first.sourceBoundary!;
    assert.ok(first.more);
    first.acknowledge();
    firstReview.close();
    let rebuilt = first.items[0].text;
    let offset = first.items[0].chunk!.end;
    let count = 0;
    while (true) {
      const review = make();
      const result = review.discover({
        boundaries: new Map([[path, boundary]]),
      });
      assert.ok(
        !result.issues.some((issue) =>
          /byte limit too small/.test(issue.reason),
        ),
      );
      const next = result.batches[0];
      assert.ok(next);
      assert.equal(next.resumedBoundary, false);
      assert.equal(next.items[0].chunk!.start, offset);
      rebuilt += next.items[0].text;
      offset = next.items[0].chunk!.end;
      next.acknowledge();
      review.close();
      if (!next.more) break;
      assert.ok(++count < 100);
    }
    assert.equal(rebuilt, text);
    const done = make();
    assert.equal(
      done.discover({ boundaries: new Map([[path, boundary]]) }).batches.length,
      0,
    );
    done.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chunk acknowledgement fails after active branch replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "session-chunks-"));
  const dir = join(root, "sessions");
  mkdirSync(dir);
  const path = join(dir, "one.jsonl");
  writeFileSync(
    path,
    [
      { type: "session", version: 3, id: "s", cwd: root },
      {
        type: "message",
        id: "m",
        parentId: null,
        message: { role: "user", content: "abc".repeat(200) },
      },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  const review = new SessionReview({
    project: root,
    sessionDir: dir,
    checkpointFile: join(root, "checkpoint"),
    maxTextBytes: 150,
  });
  try {
    const batch = review.discover().batches[0];
    appendFileSync(
      path,
      JSON.stringify({
        type: "message",
        id: "other",
        parentId: null,
        message: { role: "user", content: "other" },
      }) + "\n",
    );
    assert.throws(() => batch.acknowledge(), /changed incompatibly/);
  } finally {
    review.close();
    rmSync(root, { recursive: true, force: true });
  }
});
