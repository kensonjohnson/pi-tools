import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionReview } from "./session-review.ts";

function fixture(
  fn: (f: {
    root: string;
    project: string;
    dir: string;
    checkpoint: string;
  }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "review-followup-"));
  const project = join(root, "project"),
    dir = join(root, "sessions"),
    checkpoint = join(root, "state", "checkpoint");
  mkdirSync(project);
  mkdirSync(dir);
  try {
    fn({ root, project, dir, checkpoint });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function session(
  path: string,
  cwd: string,
  messages: unknown[],
  parentSession?: string,
) {
  const header = { type: "session", version: 3, id: path, cwd, parentSession };
  const entries = messages.map((content, i) => ({
    type: "message",
    id: String(i),
    parentId: i ? String(i - 1) : null,
    message: { role: "user", content },
  }));
  writeFileSync(
    path,
    [header, ...entries].map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
}

test("partial batches checkpoint only reviewed entries across restarts", () =>
  fixture(({ project, dir, checkpoint }) => {
    const path = join(dir, "one.jsonl");
    session(path, project, ["one", "two", "three"]);
    const make = () =>
      new SessionReview({
        project,
        sessionDir: dir,
        checkpointFile: checkpoint,
        maxTextBytes: 50,
      });
    for (const expected of ["one", "two", "three"]) {
      const r = make();
      const result = r.discover();
      const batch = result.batches[0];
      assert.deepEqual(
        batch.items.map((x) => x.text),
        [expected],
      );
      assert.equal(batch.more, expected !== "three");
      batch.acknowledge();
      r.close();
    }
    const r = make();
    assert.equal(r.discover().batches.length, 0);
    r.close();
  }));

test("oversized records and unsupported content stop progress without acknowledging them", () =>
  fixture(({ project, dir, checkpoint }) => {
    const path = join(dir, "one.jsonl");
    for (const [content, issue] of [
      ["x".repeat(500), /record .* exceeds/],
      [[{ type: "image", data: "x" }], /image/],
      [{ bad: true }, /malformed/],
      [[{ type: "text", text: 42 }], /malformed/],
    ] as const) {
      session(path, project, ["ok", content, "later"]);
      rmSync(checkpoint, { force: true });
      const r = new SessionReview({
        project,
        sessionDir: dir,
        checkpointFile: checkpoint,
        maxTextBytes: 100,
      });
      const result = r.discover();
      assert.match(result.issues.map((x) => x.reason).join(), issue);
      assert.deepEqual(
        result.batches[0].items.map((x) => x.text),
        ["ok"],
      );
      assert.equal(result.batches[0].more, true);
      result.batches[0].acknowledge();
      const again = r.discover();
      assert.equal(again.batches.length, 0);
      assert.match(again.issues.map((x) => x.reason).join(), issue);
      r.close();
    }
    const limited = new SessionReview({
      project,
      sessionDir: dir,
      checkpointFile: checkpoint,
      maxFileBytes: 1,
    });
    assert.match(
      limited
        .discover()
        .issues.map((x) => x.reason)
        .join(),
      /file or scan byte limit/,
    );
    limited.close();
  }));

test("scan work and aggregate text are bounded with resumable cursor", () =>
  fixture(({ project, dir, checkpoint }) => {
    for (let i = 0; i < 9; i++)
      session(join(dir, `${i}.jsonl`), project, [`text-${i}`]);
    const r = new SessionReview({
      project,
      sessionDir: dir,
      checkpointFile: checkpoint,
      maxSessionsPerScan: 3,
      maxScanTextBytes: 100,
    });
    const seen = new Set<string>();
    let continuation = false,
      calls = 0;
    do {
      const result = r.discover({ continue: continuation });
      calls++;
      assert.ok(result.batches.length <= 3);
      assert.ok(
        result.batches.reduce(
          (n, b) => n + Buffer.byteLength(JSON.stringify(b.items)),
          0,
        ) <= 100,
      );
      for (const b of result.batches) {
        seen.add(b.path);
        b.acknowledge();
      }
      continuation = result.continuation;
      assert.ok(calls < 20);
    } while (continuation);
    assert.equal(seen.size, 9);
    assert.ok(calls > 1);
    assert.throws(() => r.discover({ continue: true }), /no active/);
  }));

test("cross-project and unavailable fork provenance is excluded", () =>
  fixture(({ root, project, dir, checkpoint }) => {
    const other = join(root, "other");
    mkdirSync(other);
    const original = join(root, "original.jsonl");
    session(original, other, ["foreign secret"]);
    const fork = SessionManager.forkFrom(original, project, dir);
    const path = fork.getSessionFile()!;
    const r = new SessionReview({
      project,
      sessionDir: dir,
      checkpointFile: checkpoint,
    });
    const found = r.discover();
    assert.equal(found.batches.length, 0);
    assert.match(
      found.issues.map((x) => x.reason).join(),
      /cross-project fork/,
    );
    rmSync(original);
    const missing = r.discover();
    assert.equal(missing.batches.length, 0);
    assert.match(
      missing.issues.map((x) => x.reason).join(),
      /provenance unavailable/,
    );
    assert.ok(readFileSync(path, "utf8").includes("foreign secret"));
    r.close();
  }));

test("scan text budget rejects values too small to represent an empty batch", () =>
  fixture(({ project, dir, checkpoint }) => {
    assert.throws(
      () =>
        new SessionReview({
          project,
          sessionDir: dir,
          checkpointFile: checkpoint,
          maxScanTextBytes: 1,
        }),
      /at least 2/,
    );
    session(join(dir, "empty.jsonl"), project, [""]);
    const r = new SessionReview({
      project,
      sessionDir: dir,
      checkpointFile: checkpoint,
      maxScanTextBytes: 2,
    });
    const result = r.discover();
    assert.equal(result.batches.length, 1);
    assert.equal(result.continuation, false);
    result.batches[0].acknowledge();
    r.close();
  }));

test("checkpoint lock fails closed and stale concurrent batch cannot overwrite progress", () =>
  fixture(({ project, dir, checkpoint }) => {
    session(join(dir, "one.jsonl"), project, ["one"]);
    const a = new SessionReview({
      project,
      sessionDir: dir,
      checkpointFile: checkpoint,
    });
    const b = new SessionReview({
      project,
      sessionDir: dir,
      checkpointFile: checkpoint,
    });
    const first = a.discover().batches[0],
      stale = b.discover().batches[0];
    mkdirSync(join(checkpoint, ".."), { recursive: true });
    writeFileSync(checkpoint + ".lock", "");
    assert.throws(() => first.acknowledge(), /legacy review lock present/);
    rmSync(checkpoint + ".lock");
    const db = new Database(checkpoint + ".lock.db");
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => first.acknowledge(), /locked by another reviewer/);
    db.exec("ROLLBACK");
    db.close();
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `const DB=require('better-sqlite3'); const db=new DB(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.kill(process.pid, 'SIGKILL');`,
        checkpoint + ".lock.db",
      ],
      { cwd: process.cwd() },
    );
    assert.equal(child.signal, "SIGKILL");
    first.acknowledge();
    assert.throws(() => stale.acknowledge(), /checkpoint changed/);
    a.close();
    b.close();
  }));
