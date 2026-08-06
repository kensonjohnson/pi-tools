import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentLaunchPolicy } from "./launch-policy.ts";
import {
  CompletionInbox,
  CompletionInboxDelivery,
} from "./completion-inbox.ts";
import type { WorkerSession } from "./supervisor.ts";
import { WorkstreamSupervisor } from "./supervisor.ts";
import { SubagentWaitService } from "./wait-tools.ts";

class FakeWorkerSession {
  readonly sessionFile: string;
  private listeners: Array<(event: AgentSessionEvent) => void> = [];
  private runs: Array<{ resolve: () => void; reject: (error: Error) => void }> =
    [];

  constructor(sessionFile: string) {
    this.sessionFile = sessionFile;
  }

  get messages() {
    return [];
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  prompt(): Promise<void> {
    return new Promise<void>((resolve, reject) =>
      this.runs.push({ resolve, reject }),
    );
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

  settle(): void {
    this.runs.at(-1)?.resolve();
  }

  fail(message = "worker failed"): void {
    this.runs.at(-1)?.reject(new Error(message));
  }
}

const policy: SubagentLaunchPolicy = {
  maxConcurrentWorkers: 4,
  model: {
    model: { provider: "test", id: "worker", name: "Worker" } as any,
    source: "inherit",
  },
};

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("wait snapshots all live workers, returns bounded terminal reports, and consumes only that snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-subagent-wait-"));
  const sessions: FakeWorkerSession[] = [];
  const inbox = new CompletionInbox(join(root, "subagents"));
  const supervisor = new WorkstreamSupervisor({
    cwd: root,
    rootDirectory: join(root, "subagents"),
    createSession: async (options) => {
      const session = new FakeWorkerSession(
        join(options.sessionDirectory, `${sessions.length}.jsonl`),
      );
      sessions.push(session);
      return session as unknown as WorkerSession;
    },
    observeGit: async () => ({}),
  });
  supervisor.setCompletionHandler(async ({ manifest }) => {
    await inbox.create({
      workstreamId: manifest.id,
      kind: manifest.kind,
      terminalStatus: manifest.kind === "research" ? "blocked" : "settled",
      handoff: `Bounded ${manifest.kind} report for ${manifest.id}.`,
      artifactReferences: [`tmp/subagents/${manifest.id}/reports/0001.json`],
      sourceCustomType: "pi-tools:subagent-test-handoff",
      sourceDetails: { workstreamId: manifest.id },
    });
    return { status: manifest.kind === "research" ? "blocked" : "settled" };
  });
  const wait = new SubagentWaitService(supervisor, inbox);

  try {
    const task = await supervisor.launch({
      kind: "task",
      brief: "Task one",
      policy,
    });
    const research = await supervisor.launch({
      kind: "research",
      brief: "Research two",
      policy,
    });
    await tick();

    const waiting = wait.wait(undefined);
    await tick();
    const later = await supervisor.launch({
      kind: "task",
      brief: "Not in the wait snapshot",
      policy,
    });
    sessions[0]?.settle();
    sessions[1]?.settle();
    const result = await waiting;

    assert.deepEqual(
      result.workstreamIds.sort(),
      [task.id, research.id].sort(),
    );
    assert.equal(result.reports.length, 2);
    assert.deepEqual(
      result.reports.map((report) => report.deliveryState),
      ["consumed", "consumed"],
    );
    assert.equal(
      (await inbox.list()).filter(
        (record) => record.deliveryState === "consumed",
      ).length,
      2,
    );
    assert.equal(await supervisor.isLive(later.id), true);

    sessions[2]?.settle();
    await supervisor.waitForSettlement(later.id);
    const delivery = new CompletionInboxDelivery(
      { sendMessage() {} } as any,
      inbox,
    );
    assert.equal(await delivery.schedule(), true);
    const records = await inbox.list();
    assert.equal(
      records.filter((record) => record.deliveryState === "scheduled").length,
      1,
    );
    assert.equal(
      records.find((record) => record.deliveryState === "scheduled")
        ?.workstreamId,
      later.id,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wait rejects unknown or non-live selections, returns blocked reports, and preserves workers on cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-subagent-wait-"));
  const sessions: FakeWorkerSession[] = [];
  const inbox = new CompletionInbox(join(root, "subagents"));
  const supervisor = new WorkstreamSupervisor({
    cwd: root,
    rootDirectory: join(root, "subagents"),
    createSession: async (options) => {
      const session = new FakeWorkerSession(
        join(options.sessionDirectory, `${sessions.length}.jsonl`),
      );
      sessions.push(session);
      return session as unknown as WorkerSession;
    },
    observeGit: async () => ({}),
  });
  supervisor.setCompletionHandler(async ({ manifest }) => {
    await inbox.create({
      workstreamId: manifest.id,
      kind: manifest.kind,
      terminalStatus: "needs_decision",
      handoff: `Blocked report for ${manifest.id}.`,
      artifactReferences: [],
      sourceCustomType: "pi-tools:subagent-test-handoff",
      sourceDetails: { workstreamId: manifest.id },
    });
    return { status: "needs_decision" };
  });
  const wait = new SubagentWaitService(supervisor, inbox);

  try {
    await assert.rejects(wait.wait(["unknown"]), /Unknown subagent workstream/);

    const completed = await supervisor.launch({
      kind: "task",
      brief: "Completes before a later wait.",
      policy,
    });
    await tick();
    sessions[0]?.settle();
    await supervisor.waitForSettlement(completed.id);
    await assert.rejects(
      wait.wait([completed.id]),
      /not live; subagent_wait only accepts live/,
    );
    assert.equal((await inbox.listUnconsumed()).length, 1);

    const blocked = await supervisor.launch({
      kind: "task",
      brief: "Needs a parent decision.",
      policy,
    });
    await tick();
    const blockedWait = wait.wait([blocked.id]);
    await tick();
    sessions[1]?.settle();
    const blockedResult = await blockedWait;
    assert.equal(blockedResult.reports[0]?.terminalStatus, "needs_decision");

    const running = await supervisor.launch({
      kind: "task",
      brief: "Keep running when the parent stops waiting.",
      policy,
    });
    await tick();
    const controller = new AbortController();
    const cancelled = wait.wait([running.id], controller.signal);
    await tick();
    controller.abort();
    await assert.rejects(cancelled, /was cancelled/);
    assert.equal(await supervisor.isLive(running.id), true);
    assert.equal((await inbox.listUnconsumed()).length, 1);
    sessions[2]?.settle();
    await supervisor.waitForSettlement(running.id);
    assert.equal((await supervisor.get(running.id))?.status, "needs_decision");
    assert.equal((await inbox.listUnconsumed()).length, 2);
    assert.equal(
      (await inbox.list()).find((record) => record.workstreamId === running.id)
        ?.deliveryState,
      "pending",
    );

    const failing = await supervisor.launch({
      kind: "task",
      brief: "Fail after the wait snapshot.",
      policy,
    });
    await tick();
    const failureWait = wait.wait([failing.id]);
    await tick();
    sessions[3]?.fail("intentional failure");
    await assert.rejects(failureWait, /ended failed: intentional failure/);
    assert.equal((await supervisor.get(failing.id))?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
