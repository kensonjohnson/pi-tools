import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionReview } from "./session-review.ts";
import { validateSessionBatch } from "./reviewer-session.ts";

test("long fork ancestry is verified iteratively and cycles still fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-deep-forks-"));
  const dir = join(root, "sessions");
  mkdirSync(dir);
  const paths = Array.from({ length: 13 }, (_, i) =>
    i === 12 ? join(dir, "leaf.jsonl") : join(root, `ancestor-${i}.jsonl`),
  );
  const entry = {
    type: "message",
    id: "shared",
    parentId: null,
    message: { role: "user", content: "shared history" },
  };
  const put = (i: number, parent?: string, cwd = root) => {
    const header = {
      type: "session",
      version: 3,
      id: `session-${i}`,
      cwd,
      ...(parent === undefined ? {} : { parentSession: parent }),
    };
    writeFileSync(
      paths[i],
      [header, entry].map(JSON.stringify).join("\n") + "\n",
    );
  };
  for (let i = 0; i < paths.length; i++)
    put(i, i > 0 ? paths[i - 1] : undefined);
  const make = () =>
    new SessionReview({
      project: root,
      sessionDir: dir,
      checkpointFile: join(root, "checkpoint"),
      maxSessionsPerScan: 2,
      maxScanBytes: 128,
    });
  const review = make();
  try {
    const found = review.discover();
    assert.equal(found.batches.length, 1, JSON.stringify(found.issues));
    assert.equal(found.batches[0].items[0].text, "shared history");
    await validateSessionBatch(root, found.batches[0]);
    put(0, paths[12]);
    await assert.rejects(
      validateSessionBatch(root, found.batches[0]),
      /cyclic/,
    );
    assert.throws(() => found.batches[0].acknowledge(), /provenance changed/);
    const cycle = review.discover();
    assert.equal(cycle.batches.length, 0);
    assert.match(cycle.issues.map((i) => i.reason).join(), /provenance cycle/);
    put(0, undefined, join(root, "foreign"));
    const foreign = review.discover();
    assert.equal(foreign.batches.length, 0);
    assert.match(
      foreign.issues.map((i) => i.reason).join(),
      /cross-project fork/,
    );
  } finally {
    review.close();
    rmSync(root, { recursive: true, force: true });
  }
});
