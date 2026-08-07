import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentLaunchPolicy } from "./launch-policy.ts";
import { type WorkerSession, WorkstreamSupervisor } from "./supervisor.ts";

class FakeWorkerSession {
  readonly sessionFile: string;
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
  readonly followUps: string[] = [];
  aborts = 0;
  disposed = false;
  private listeners: Array<(event: AgentSessionEvent) => void> = [];
  private runs: Array<{ resolve: () => void; reject: (error: Error) => void }> =
    [];
  private pendingSettle = false;
  private pendingFailure?: Error;

  constructor(sessionFile: string) {
    this.sessionFile = sessionFile;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  prompt(text: string): Promise<void> {
    this.prompts.push(text);
    return new Promise<void>((resolve, reject) => {
      this.runs.push({ resolve, reject });
      if (this.pendingFailure) {
        const error = this.pendingFailure;
        this.pendingFailure = undefined;
        reject(error);
      } else if (this.pendingSettle) {
        this.pendingSettle = false;
        resolve();
      }
    });
  }

  steer(text: string): Promise<void> {
    this.steers.push(text);
    return Promise.resolve();
  }

  followUp(text: string): Promise<void> {
    this.followUps.push(text);
    return Promise.resolve();
  }

  abort(): Promise<void> {
    this.aborts++;
    this.settle();
    return Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  settle(run = this.runs.length - 1): void {
    const pending = this.runs[run];
    if (pending) pending.resolve();
    else this.pendingSettle = true;
  }

  fail(message: string, run = this.runs.length - 1): void {
    const pending = this.runs[run];
    if (pending) pending.reject(new Error(message));
    else this.pendingFailure = new Error(message);
  }
}

const policy: SubagentLaunchPolicy = {
  maxConcurrentWorkers: 2,
  model: {
    model: { provider: "test", id: "worker", name: "Worker" } as any,
    source: "inherit",
  },
};

async function withSupervisor(
  run: (options: {
    root: string;
    supervisor: WorkstreamSupervisor;
    sessions: FakeWorkerSession[];
    events: string[];
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-supervisor-"));
  const sessions: FakeWorkerSession[] = [];
  const events: string[] = [];
  const supervisor = new WorkstreamSupervisor({
    cwd: root,
    rootDirectory: join(root, "subagents"),
    createSession: async (options) => {
      const session = new FakeWorkerSession(
        join(options.sessionDirectory, `worker-${sessions.length}.jsonl`),
      );
      sessions.push(session);
      return session as unknown as WorkerSession;
    },
    observeGit: async () => ({ branch: "main", commit: "abc123" }),
    onEvent: (event) => events.push(event.type),
  });
  try {
    await run({ root, supervisor, sessions, events });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("starts persistent SDK workstreams with a manifest, journal, and Git observation", async () => {
  await withSupervisor(async ({ root, supervisor, sessions, events }) => {
    const workstream = await supervisor.launch({
      kind: "task",
      brief: "Inspect the authentication flow.",
      policy,
    });
    assert.equal(workstream.status, "running");
    assert.equal(sessions.length, 1);
    assert.equal(workstream.git.branch, "main");
    assert.equal(workstream.git.commit, "abc123");
    assert.match(
      workstream.workerSessionDirectory,
      /subagents\/[^/]+\/session$/,
    );
    assert.match(workstream.workerSessionFile!, /worker-0\.jsonl$/);

    sessions[0].emit({ type: "tool_execution_start" } as AgentSessionEvent);
    sessions[0].emit({ type: "tool_execution_end" } as AgentSessionEvent);
    await supervisor.flush();
    const journal = await readFile(
      join(root, "subagents", workstream.id, "journal.md"),
      "utf8",
    );
    assert.match(journal, /Worker started a tool call/);
    assert.match(journal, /Worker finished a tool call/);
    assert.deepEqual(events, ["started", "tool_started", "tool_finished"]);

    sessions[0].settle();
    await supervisor.waitForSettlement(workstream.id);
    assert.equal((await supervisor.get(workstream.id))?.status, "settled");
  });
});

test("enforces one shared running cap without queueing task or research work", async () => {
  await withSupervisor(async ({ supervisor, sessions }) => {
    const capOne = { ...policy, maxConcurrentWorkers: 1 };
    const first = await supervisor.launch({
      kind: "task",
      brief: "First task.",
      policy: capOne,
    });
    await assert.rejects(
      supervisor.launch({
        kind: "research",
        brief: "Research this.",
        policy: capOne,
      }),
      /concurrency limit \(1\) is reached/,
    );
    assert.equal(sessions.length, 1);

    sessions[0].settle();
    await supervisor.waitForSettlement(first.id);
    const second = await supervisor.launch({
      kind: "research",
      brief: "Research this after settlement.",
      policy: capOne,
    });
    assert.equal(second.kind, "research");
    sessions[1].settle();
    await supervisor.waitForSettlement(second.id);
  });
});

test("redirects, checkpoints, pauses, resumes, and cancels only on explicit parent control", async () => {
  await withSupervisor(async ({ root, supervisor, sessions }) => {
    const workstream = await supervisor.launch({
      kind: "task",
      brief: "Make one local change.",
      policy,
    });
    await Promise.resolve();
    await supervisor.redirect(
      workstream.id,
      "Prioritize the failing test first.",
    );
    await supervisor.followUp(workstream.id, "Then report the result.");
    assert.deepEqual(sessions[0].steers, [
      "Prioritize the failing test first.",
    ]);
    assert.deepEqual(sessions[0].followUps, ["Then report the result."]);

    const checkpoint = await supervisor.checkpoint(
      workstream.id,
      "Save before review.",
    );
    assert.equal(checkpoint.recovery?.reason, "Save before review.");
    assert.ok((checkpoint.recovery?.journalTail.length ?? 0) > 0);
    const journal = await readFile(
      join(root, "subagents", workstream.id, "journal.md"),
      "utf8",
    );
    assert.match(journal, /checkpoint: Save before review/);

    const paused = await supervisor.pause(
      workstream.id,
      "Stop for a parent decision.",
    );
    assert.equal(paused.status, "paused");
    assert.equal(sessions[0].aborts, 1);
    await assert.rejects(
      supervisor.followUp(workstream.id, "Do not queue while paused."),
      /paused; explicitly resume/,
    );

    const resumed = await supervisor.resume(workstream.id, policy);
    assert.equal(resumed.status, "running");
    assert.equal(sessions.length, 1);
    await Promise.resolve();
    assert.match(
      sessions[0].prompts.at(-1) ?? "",
      /Explicit workstream resume/,
    );
    await supervisor.redirect(
      workstream.id,
      "Continue with the chosen option.",
    );
    assert.deepEqual(sessions[0].steers, [
      "Prioritize the failing test first.",
      "Continue with the chosen option.",
    ]);

    const cancelled = await supervisor.cancel(
      workstream.id,
      "No longer needed.",
    );
    assert.equal(cancelled.status, "cancelled");
    assert.equal(sessions[0].disposed, true);
    await assert.rejects(supervisor.resume(workstream.id, policy), /cancelled/);
  });
});

test("recovers and reopens interrupted persisted worker sessions only after explicit resume", async () => {
  await withSupervisor(async ({ root, supervisor, sessions }) => {
    const workstream = await supervisor.launch({
      kind: "task",
      brief: "Continue across an extension reload.",
      policy,
    });
    await Promise.resolve();
    const reopenedOptions: Array<{ resumeSessionFile?: string }> = [];
    const reloaded = new WorkstreamSupervisor({
      cwd: root,
      rootDirectory: join(root, "subagents"),
      createSession: async (options) => {
        reopenedOptions.push(options);
        return new FakeWorkerSession(
          join(options.sessionDirectory, "reopened.jsonl"),
        ) as unknown as WorkerSession;
      },
    });
    const recovered = await reloaded.recoverInterrupted();
    assert.deepEqual(
      recovered.map((entry) => entry.id),
      [workstream.id],
    );
    const paused = await reloaded.get(workstream.id);
    assert.equal(paused?.status, "paused");
    assert.equal(sessions.length, 1);
    assert.equal(
      paused?.recovery?.workerSessionFile,
      workstream.workerSessionFile,
    );

    await reloaded.resume(workstream.id, policy);
    assert.equal(reopenedOptions.length, 1);
    assert.equal(
      reopenedOptions[0]?.resumeSessionFile,
      workstream.workerSessionFile,
    );
  });
});

test("shutdown records paused recovery metadata then aborts and disposes live workers", async () => {
  await withSupervisor(async ({ supervisor, sessions }) => {
    const workstream = await supervisor.launch({
      kind: "task",
      brief: "Stop when the Pi session shuts down.",
      policy,
    });
    await Promise.resolve();
    const paused = await supervisor.shutdown();
    assert.deepEqual(
      paused.map((entry) => entry.id),
      [workstream.id],
    );
    assert.equal((await supervisor.get(workstream.id))?.status, "paused");
    assert.equal(
      (await supervisor.get(workstream.id))?.recovery?.reason,
      "Pi session ended; explicit resume is required.",
    );
    assert.equal(sessions[0].aborts, 1);
    assert.equal(sessions[0].disposed, true);
  });
});

test("marks a failed worker failed once and restores interrupted work paused", async () => {
  await withSupervisor(async ({ root, supervisor, sessions }) => {
    const failed = await supervisor.launch({
      kind: "task",
      brief: "This worker fails.",
      policy,
    });
    sessions[0].fail("model connection lost");
    await supervisor.waitForSettlement(failed.id);
    const failedManifest = await supervisor.get(failed.id);
    assert.equal(failedManifest?.status, "failed");
    assert.match(failedManifest?.failure ?? "", /connection lost/);
    assert.equal(sessions.length, 1);

    const blocked = await supervisor.launch({
      kind: "task",
      brief: "This worker needs a decision.",
      policy,
    });
    await supervisor.markBlocked(blocked.id, "Need a product decision.");
    assert.equal((await supervisor.get(blocked.id))?.status, "blocked");
    sessions[1].settle();
    await supervisor.waitForSettlement(blocked.id);

    const interrupted = await supervisor.launch({
      kind: "research",
      brief: "This worker is interrupted by shutdown.",
      policy,
    });
    const reloaded = new WorkstreamSupervisor({
      cwd: root,
      rootDirectory: join(root, "subagents"),
      createSession: async () => {
        throw new Error("Recovery must not start a worker automatically.");
      },
    });
    const recovered = await reloaded.recoverInterrupted();
    assert.deepEqual(
      recovered.map((entry) => entry.id),
      [interrupted.id],
    );
    assert.equal((await reloaded.get(interrupted.id))?.status, "paused");
    assert.equal(sessions.length, 3);
  });
});
