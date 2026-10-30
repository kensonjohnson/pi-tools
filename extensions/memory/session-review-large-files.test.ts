import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionReview } from "./session-review.ts";
import { validateSessionBatch } from "./reviewer-session.ts";

test("first fork and its provenance can exceed a scan budget without starvation", async () => {
  const root = mkdtempSync(join(tmpdir(), "large-fork-review-"));
  const dir = join(root, "sessions");
  mkdirSync(dir);
  const parent = join(root, "parent.jsonl");
  const child = join(dir, "child.jsonl");
  const entry = {
    type: "message",
    id: "shared",
    parentId: null,
    message: { role: "user", content: "a".repeat(1000) },
  };
  const header = { type: "session", version: 3, id: "parent", cwd: root };
  writeFileSync(parent, [header, entry].map(JSON.stringify).join("\n") + "\n");
  writeFileSync(
    child,
    [{ ...header, id: "child", parentSession: parent }, entry]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  const review = new SessionReview({
    project: root,
    sessionDir: dir,
    checkpointFile: join(root, "checkpoint"),
    maxScanBytes: 10,
    maxSessionsPerScan: 1,
  });
  try {
    const found = review.discover();
    assert.equal(found.batches.length, 1, JSON.stringify(found.issues));
    await validateSessionBatch(root, found.batches[0]);
    found.batches[0].acknowledge();
  } finally {
    review.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mib of [9, 33])
  test(`reviews a ${mib} MiB source across chunk checkpoints`, async () => {
    const root = mkdtempSync(join(tmpdir(), "large-review-"));
    const dir = join(root, "sessions");
    mkdirSync(dir);
    const path = join(dir, "large.jsonl");
    const content = "abcd".repeat((mib * 1024 * 1024) / 4);
    writeFileSync(
      path,
      [
        { type: "session", version: 3, id: "large", cwd: root },
        {
          type: "message",
          id: "message",
          parentId: null,
          message: { role: "user", content },
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
        maxTextBytes: 8 * 1024 * 1024,
        maxScanTextBytes: 8 * 1024 * 1024,
      });
    try {
      let offset = 0,
        count = 0;
      while (true) {
        const review = make();
        try {
          const found = review.discover();
          assert.ok(found.batches.length, JSON.stringify(found.issues));
          const batch = found.batches[0];
          assert.equal(batch.items.length, 1);
          const item = batch.items[0];
          assert.equal(item.id, "message");
          assert.equal(item.role, "user");
          assert.equal(item.chunk?.start, offset);
          assert.equal(item.chunk?.total, content.length);
          assert.equal(
            item.text,
            content.slice(item.chunk!.start, item.chunk!.end),
          );
          await validateSessionBatch(root, batch);
          offset = item.chunk!.end;
          count++;
          batch.acknowledge();
          if (!batch.more) break;
          assert.ok(count < 10);
        } finally {
          review.close();
        }
      }
      assert.equal(offset, content.length);
      assert.ok(count > 1);
      const done = make();
      try {
        assert.equal(done.discover().batches.length, 0);
      } finally {
        done.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
