import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionReview } from "./session-review.ts";
import { validateSessionBatch } from "./reviewer-session.ts";

function flush(m: SessionManager) {
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
    timestamp: 1,
  } as any);
}
const user = (content: string) => ({
  role: "user" as const,
  content,
  timestamp: 1,
});

test("branched-session copies with removed and recreated labels verify correctly", async () => {
  const root = await mkdtemp(join(tmpdir(), "verified-branch-"));
  try {
    const project = join(root, "project"),
      dir = join(root, "sessions");
    await mkdir(project);
    await mkdir(dir);
    const manager = SessionManager.create(project, dir);
    const first = manager.appendMessage(user("First"));
    manager.appendLabelChange(first, "bookmark");
    manager.appendMessage(user("Second"));
    flush(manager);
    const forkPath = manager.createBranchedSession(manager.getLeafId()!)!;
    manager.appendMessage(user("New activity"));
    const reviewer = new SessionReview({
      project,
      sessionDir: dir,
      checkpointFile: join(root, "checkpoint"),
    });
    try {
      const found = reviewer.discover();
      const batch = found.batches.find((entry) => entry.path === forkPath);
      assert.ok(batch);
      assert.deepEqual(
        batch.items.map((entry) => entry.text),
        ["First", "Second", "New activity"],
      );
      await validateSessionBatch(project, batch);
    } finally {
      reviewer.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verified same-project nested forks retain their own activity and revalidate every ancestor", async () => {
  const root = await mkdtemp(join(tmpdir(), "verified-fork-"));
  try {
    const project = join(root, "project"),
      dir = join(root, "sessions"),
      parents = join(root, "parents");
    await mkdir(project);
    await mkdir(dir);
    await mkdir(parents);
    const source = SessionManager.create(project, parents);
    source.appendMessage(user("Original fact"));
    flush(source);
    const first = SessionManager.forkFrom(
      source.getSessionFile()!,
      project,
      parents,
    );
    first.appendMessage(user("First fork activity"));
    const second = SessionManager.forkFrom(
      first.getSessionFile()!,
      project,
      dir,
    );
    second.appendMessage(user("Second fork activity"));
    // A source can grow after forking; earlier copied records still match.
    first.appendMessage(user("Later parent activity"));
    const reviewer = new SessionReview({
      project,
      sessionDir: dir,
      checkpointFile: join(root, "checkpoint"),
    });
    try {
      const found = reviewer.discover();
      const batch = found.batches.find(
        (entry) => entry.path === second.getSessionFile(),
      );
      assert.ok(batch);
      assert.deepEqual(
        batch.items.map((entry) => entry.text),
        ["Original fact", "First fork activity", "Second fork activity"],
      );
      await validateSessionBatch(project, batch);
      const sourcePath = source.getSessionFile()!;
      const rows = (await readFile(sourcePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      rows.find((row) => row.message?.role === "assistant").message.model =
        "modified";
      await writeFile(sourcePath, rows.map(JSON.stringify).join("\n") + "\n");
      await assert.rejects(
        validateSessionBatch(project, batch),
        /unverifiable or tampered/,
      );
      assert.throws(() => batch.acknowledge(), /fork provenance changed/);
      assert.ok(
        reviewer
          .discover()
          .issues.some((issue) =>
            /unverifiable or tampered/.test(issue.reason),
          ),
      );
    } finally {
      reviewer.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
