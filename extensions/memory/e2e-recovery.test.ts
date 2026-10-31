import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { MemoryScheduler, reviewProjectSessions } from "./scheduler.ts";
import { SessionReview } from "./session-review.ts";

function createSession(cwd: string, dir: string) {
  const session = SessionManager.create(cwd, dir);
  session.appendMessage({
    role: "user",
    content: "Please check browser facts.",
    timestamp: 1,
  });
  session.appendMessage({
    role: "assistant",
    content: [],
    api: "fake",
    provider: "fake",
    model: "fake",
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
async function waitFor(fn: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("scheduler timeout");
}
async function fixture(
  fn: (
    cwd: string,
    sessions: string,
    runtime: string,
    store: MemoryManager,
  ) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "memory-e2e-recovery-")),
    sessions = join(cwd, "sessions"),
    runtime = join(cwd, "runtime");
  await mkdir(sessions);
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    createSession(cwd, sessions);
    await fn(cwd, sessions, runtime, store);
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("manual edits during automatic apply are preserved and leave a durable uncertain review", () =>
  fixture(async (cwd, sessions, runtime, store) => {
    const old = (await store.remember("knowledge", "Browser uses Puppeteer."))
      .memory;
    await writeFile(join(cwd, "browser.txt"), "Browser backend: Playwright.\n");
    const file = join(cwd, ".pi", "memory", "knowledge.ndjson");
    let captures = 0;
    const wrapper = {
      captureAddPrecondition: async () => {
        const snapshot = await store.captureAddPrecondition();
        if (++captures === 2) {
          const row = JSON.parse((await readFile(file, "utf8")).trim());
          row.content = "Human edited browser guidance.";
          await writeFile(file, JSON.stringify(row) + "\n");
        }
        return snapshot;
      },
      remember: store.remember.bind(store),
      update: store.update.bind(store),
      forget: store.forget.bind(store),
      move: store.move.bind(store),
    };
    const model: any = {
      generate: async ({ instruction, data }: any) =>
        instruction.startsWith("Select")
          ? { paths: ["browser.txt"] }
          : instruction.startsWith("Independently classify")
            ? {
                authority: "fact",
                noInstructionOrPreference: true,
                reason: "Descriptive fact.",
              }
            : instruction.startsWith("Independently")
              ? { verdict: "supported", reason: "Current repository evidence." }
              : {
                  action: "update",
                  id: old.id,
                  content: "Browser uses Playwright.",
                  targetAuthority: "fact",
                  citation: {
                    kind: "file",
                    id: data.files[0].id,
                    quote: "Browser backend: Playwright.",
                  },
                  reason: "Browser implementation changed.",
                },
    };
    const checkpoint = join(runtime, "progress.json");
    const scheduler = new MemoryScheduler({
      project: cwd,
      runtimeDir: runtime,
      sessionDir: sessions,
      debounceMs: 0,
      cooldownMs: 0,
      retryMs: 5,
      work: async (dir, signal) =>
        reviewProjectSessions({
          project: cwd,
          sessionDir: dir,
          checkpointFile: checkpoint,
          reviewer: new MemoryReviewer({ project: cwd, store: wrapper, model }),
          signal,
        }),
    });
    try {
      await scheduler.activity();
      await waitFor(() => scheduler.status().paused);
      assert.equal(scheduler.status().status, "uncertain");
      assert.match(
        await readFile(file, "utf8"),
        /Human edited browser guidance/,
      );
      assert.ok(
        (
          await store.recall({
            query: "Human edited browser guidance",
            category: "knowledge",
          })
        ).memories.some((m) => m.id === old.id),
      );
      const source = new SessionReview({
        project: cwd,
        sessionDir: sessions,
        checkpointFile: checkpoint,
      });
      assert.equal(source.discover().batches.length, 1);
      source.close();
      const count = captures;
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(captures, count);
    } finally {
      await scheduler.shutdown();
    }
  }));

test("cancelled pre-apply work survives shutdown and resumes from unacknowledged session", () =>
  fixture(async (cwd, sessions, runtime, store) => {
    const checkpoint = join(runtime, "progress.json");
    let started = false;
    const pendingModel: any = {
      generate: async ({ signal }: any) => {
        started = true;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
        return { paths: [] };
      },
    };
    const make = (model: any) =>
      new MemoryScheduler({
        project: cwd,
        runtimeDir: runtime,
        sessionDir: sessions,
        debounceMs: 0,
        cooldownMs: 0,
        retryMs: 5,
        work: async (dir, signal) =>
          reviewProjectSessions({
            project: cwd,
            sessionDir: dir,
            checkpointFile: checkpoint,
            reviewer: new MemoryReviewer({ project: cwd, store, model }),
            signal,
          }),
      });
    const first = make(pendingModel);
    await first.activity();
    await waitFor(() => started);
    assert.equal((await first.shutdown()).status, "closed");
    const before = new SessionReview({
      project: cwd,
      sessionDir: sessions,
      checkpointFile: checkpoint,
    });
    assert.equal(before.discover().batches.length, 1);
    before.close();
    let calls = 0;
    const model: any = {
      generate: async ({ instruction }: any) => {
        calls++;
        return instruction.startsWith("Select")
          ? { paths: [] }
          : {
              action: "no_change",
              evidenceSufficient: true,
              reason: "Session evidence reviewed.",
            };
      },
    };
    const resumed = make(model);
    try {
      resumed.start();
      await waitFor(
        () => !resumed.status().pending && !resumed.status().inflight,
      );
      assert.equal(calls, 2);
      const after = new SessionReview({
        project: cwd,
        sessionDir: sessions,
        checkpointFile: checkpoint,
      });
      assert.equal(after.discover().batches.length, 0);
      after.close();
    } finally {
      await resumed.shutdown();
    }
  }));
