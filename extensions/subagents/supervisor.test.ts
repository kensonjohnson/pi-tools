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
  private listeners: Array<(event: AgentSessionEvent) => void> = [];
  private resolvePrompt!: () => void;
  private rejectPrompt!: (error: Error) => void;
  readonly promptResult = new Promise<void>((resolve, reject) => {
    this.resolvePrompt = resolve;
    this.rejectPrompt = reject;
  });

  constructor(sessionFile: string) {
    this.sessionFile = sessionFile;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  prompt(): Promise<void> {
    return this.promptResult;
  }

  steer(): Promise<void> {
    return Promise.resolve();
  }

  followUp(): Promise<void> {
    return Promise.resolve();
  }

  abort(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {}

  emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  settle(): void {
    this.resolvePrompt();
  }

  fail(message: string): void {
    this.rejectPrompt(new Error(message));
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
