import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MemoryManager } from "./core.ts";
import { SessionReview, type ReviewBatch } from "./session-review.ts";
import { validateSessionBatch } from "./reviewer-session.ts";
import { MemoryReviewer } from "./reviewer.ts";

async function fixture(
  run: (root: string, project: string, dir: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "memory-fork-provenance-"));
  try {
    const project = join(root, "project"),
      dir = join(root, "sessions");
    await mkdir(project);
    await mkdir(dir);
    await run(root, project, dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function user(content: string) {
  return { role: "user" as const, content, timestamp: 1 };
}
function flush(manager: SessionManager) {
  manager.appendMessage({
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

test("same-project fork with forged copied messages is excluded while independent sessions remain reviewable", async () => {
  await fixture(async (root, project, dir) => {
    const parentDir = join(root, "parent");
    await mkdir(parentDir);
    const original = SessionManager.create(project, parentDir);
    original.appendMessage(user("Trusted original"));
    flush(original);
    const fork = SessionManager.forkFrom(
      original.getSessionFile()!,
      project,
      dir,
    );
    fork.appendMessage(user("Legitimate own new activity"));
    const path = fork.getSessionFile()!;
    const lines = (await readFile(path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const copied = lines.find(
      (entry) => entry.type === "message" && entry.message?.role === "user",
    );
    copied.message.content = "Forged copied instruction";
    await writeFile(path, lines.map(JSON.stringify).join("\n") + "\n");
    const independent = SessionManager.create(project, dir);
    independent.appendMessage(user("Independent activity"));
    flush(independent);
    const review = new SessionReview({
      project,
      sessionDir: dir,
      checkpointFile: join(root, "checkpoint"),
    });
    try {
      const result = review.discover();
      assert.ok(
        result.issues.some(
          (issue) =>
            issue.path === path &&
            /unverifiable or tampered/.test(issue.reason),
        ),
      );
      assert.equal(
        result.batches.some((batch) => batch.path === path),
        false,
      );
      const batch = result.batches.find(
        (candidate) => candidate.path === independent.getSessionFile(),
      );
      assert.ok(batch);
      assert.deepEqual(
        batch.items.map((item) => item.text),
        ["Independent activity"],
      );
      batch.acknowledge();
      assert.equal(review.discover().batches.length, 0);
      assert.match(
        review
          .discover()
          .issues.map((issue) => issue.reason)
          .join(),
        /unverifiable or tampered/,
      );
    } finally {
      review.close();
    }
  });
});

test("reviewer rejects tampered caller-supplied fork batch before model exposure", async () => {
  await fixture(async (root, project, dir) => {
    const parentDir = join(root, "parent");
    await mkdir(parentDir);
    const source = SessionManager.create(project, parentDir);
    const first = source.appendMessage(user("Potential inherited instruction"));
    flush(source);
    const fork = SessionManager.forkFrom(
      source.getSessionFile()!,
      project,
      dir,
    );
    const batch: ReviewBatch = {
      path: fork.getSessionFile()!,
      sessionId: fork.getSessionId(),
      leaf: fork.getLeafId(),
      items: [
        { id: first, role: "user", text: "Potential inherited instruction" },
      ],
      more: false,
      acknowledge() {
        throw new Error("must not acknowledge");
      },
    };
    const rows = (await readFile(batch.path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    rows.find((entry) => entry.message?.role === "assistant").message.model =
      "tampered";
    await writeFile(batch.path, rows.map(JSON.stringify).join("\n") + "\n");
    await assert.rejects(
      validateSessionBatch(project, batch),
      /unverifiable or tampered/,
    );
    const store = new MemoryManager(project, { semanticEnabled: false });
    let calls = 0;
    try {
      const reviewer = new MemoryReviewer({
        project,
        store,
        model: {
          async generate() {
            calls++;
            return { paths: [] };
          },
        },
      });
      await assert.rejects(
        reviewer.review({ batch }),
        /unverifiable or tampered/,
      );
      assert.equal(calls, 0);
    } finally {
      await store.close();
    }
  });
});

test("fork header introduced after discovery rejects stale batch on revalidation", async () => {
  await fixture(async (root, project, dir) => {
    const source = SessionManager.create(project, dir);
    source.appendMessage(user("Original evidence"));
    flush(source);
    const review = new SessionReview({
      project,
      sessionDir: dir,
      checkpointFile: join(root, "checkpoint"),
    });
    try {
      const batch = review.discover().batches[0];
      assert.ok(batch);
      await validateSessionBatch(project, batch);
      const path = source.getSessionFile()!;
      const rows = (await readFile(path, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const parentDir = join(root, "parent");
      await mkdir(parentDir);
      const parent = SessionManager.create(project, parentDir);
      parent.appendMessage(user("Different parent"));
      flush(parent);
      rows[0].parentSession = parent.getSessionFile();
      await writeFile(path, rows.map(JSON.stringify).join("\n") + "\n");
      await assert.rejects(
        validateSessionBatch(project, batch),
        /unverifiable or tampered/,
      );
      assert.throws(() => batch.acknowledge(), /changed incompatibly/);
    } finally {
      review.close();
    }
  });
});
