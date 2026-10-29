import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionReview } from "./session-review.ts";

function fixture(
  fn: (x: {
    root: string;
    project: string;
    dir: string;
    review: () => SessionReview;
  }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "memory-review-"));
  const project = join(root, "project"),
    dir = join(root, "sessions");
  mkdirSync(project);
  mkdirSync(dir);
  const review = () =>
    new SessionReview({
      project,
      sessionDir: dir,
      checkpointFile: join(root, "state", "review.json"),
    });
  try {
    fn({ root, project, dir, review });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const user = (content: string) => ({
  role: "user" as const,
  content,
  timestamp: Date.now(),
});
const flush = (m: SessionManager) =>
  m.appendMessage({
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as any);

test("incremental acknowledgements, restart, active append, branch and fork", () =>
  fixture(({ project, dir, review }) => {
    const manager = SessionManager.create(project, dir);
    const a = manager.appendMessage(user("first"));
    manager.appendMessage(user("abandoned"));
    flush(manager);
    const r = review();
    const first = r.discover().batches[0];
    assert.deepEqual(
      first.items.map((x) => x.text),
      ["first", "abandoned"],
    );
    assert.equal(review().discover().batches.length, 1); // no implicit checkpoint
    first.acknowledge();
    assert.equal(review().discover().batches.length, 0);
    manager.branch(a);
    manager.appendMessage(user("new branch"));
    const branched = review().discover();
    assert.match(branched.issues.map((x) => x.reason).join(), /branch changed/);
    assert.deepEqual(
      branched.batches[0].items.map((x) => x.text),
      ["first", "new branch"],
    );
    const pending = branched.batches[0];
    manager.appendMessage(user("later"));
    pending.acknowledge();
    const next = review().discover().batches[0];
    assert.deepEqual(
      next.items.map((x) => x.text),
      ["later"],
    );
    next.acknowledge();
    const fork = manager.createBranchedSession(manager.getLeafId()!);
    assert.ok(fork);
    manager.appendMessage(user("fork"));
    flush(manager);
    const forkScan = review().discover();
    assert.match(
      forkScan.issues.map((x) => x.reason).join(),
      /fork copied history verified/,
    );
    const forkBatch = forkScan.batches.find((x) => x.path === fork)!;
    assert.ok(forkBatch.parentSession);
    assert.deepEqual(
      forkBatch.items.map((x) => x.text),
      ["first", "new branch", "later", "fork"],
    );
  }));

test("replacement, truncation, malformed tails and changed branches fail closed", () =>
  fixture(({ project, dir, review }) => {
    const m = SessionManager.create(project, dir);
    const a = m.appendMessage(user("one"));
    flush(m);
    const path = m.getSessionFile()!;
    const pending = review().discover().batches[0];
    m.appendMessage(user("other"));
    m.branch(a);
    m.appendMessage(user("replacement branch"));
    assert.throws(() => pending.acknowledge(), /incompatibly/);
    review().discover().batches[0].acknowledge();
    m.appendMessage(user("more"));
    const b = review().discover().batches[0];
    appendFileSync(path, '{"bad"');
    assert.throws(() => b.acknowledge(), /incomplete/);
    assert.match(
      review()
        .discover()
        .issues.map((x) => x.reason)
        .join(),
      /incomplete/,
    );
    const saved = path + ".old";
    renameSync(path, saved);
    writeFileSync(path, "{broken}\n");
    assert.match(
      review()
        .discover()
        .issues.map((x) => x.reason)
        .join(),
      /malformed/,
    );
    renameSync(saved, path);
    // Restore valid bytes by truncating to first line and create a fresh valid source.
    const n = SessionManager.create(project, dir);
    n.appendMessage(user("new"));
    flush(n);
    const newPath = n.getSessionFile()!;
    renameSync(newPath, path);
    const result = review().discover();
    assert.match(
      result.issues.map((x) => x.reason).join(),
      /replaced or truncated/,
    );
    assert.deepEqual(
      result.batches.find((x) => x.path === path)?.items.map((x) => x.text),
      ["new"],
    );
  }));

test("project isolation, limits and checkpoint mismatch", () =>
  fixture(({ root, project, dir, review }) => {
    const m = SessionManager.create(project, dir);
    m.appendMessage(user("hello"));
    flush(m);
    const other = join(root, "other");
    mkdirSync(other);
    const foreignManager = SessionManager.create(other, dir);
    foreignManager.appendMessage(user("private"));
    flush(foreignManager);
    const d = review().discover();
    assert.equal(d.batches.length, 1);
    assert.match(d.issues.map((x) => x.reason).join(), /different project/);
    const small = new SessionReview({
      project,
      sessionDir: dir,
      checkpointFile: join(root, "small"),
      maxTextBytes: 1,
    });
    assert.equal(small.discover().batches.length, 0);
    assert.match(
      small
        .discover()
        .issues.map((x) => x.reason)
        .join(),
      /byte limit/,
    );
    d.batches[0].acknowledge();
    const foreign = new SessionReview({
      project: other,
      sessionDir: dir,
      checkpointFile: join(root, "state", "review.json"),
    });
    assert.throws(() => foreign.discover(), /foreign/);
  }));
