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
  type CompletionInboxRecord,
} from "./completion-inbox.ts";
import type { WorkerSession } from "./supervisor.ts";
import { WorkstreamSupervisor } from "./supervisor.ts";
import {
  formatWaitResult,
  registerSubagentWaitTool,
  SubagentWaitService,
} from "./wait-tools.ts";

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

const plainTheme = {
  fg(_color: string, text: string) {
    return text;
  },
};

test("formats ready reports alongside non-error failed workstream details", () => {
  const output = formatWaitResult({
    workstreamIds: ["settled-worker", "failed-worker"],
    reports: [
      {
        workstreamId: "settled-worker",
        handoff: "Ready handoff.",
      } as CompletionInboxRecord,
    ],
    failures: [
      {
        workstreamId: "failed-worker",
        status: "failed",
        detail: "intentional failure",
      },
    ],
  });

  assert.match(output, /Waited worker reports:/);
  assert.match(output, /Ready handoff\./);
  assert.match(
    output,
    /Failed subagent workstream 'failed-worker': intentional failure/,
  );
});

test("renders an interrupted wait as a non-error outcome", async () => {
  let definition:
    | {
        execute: (...args: any[]) => Promise<any>;
        renderShell?: string;
        renderCall?: (...args: any[]) => { render(width: number): string[] };
        renderResult?: (...args: any[]) => { render(width: number): string[] };
      }
    | undefined;
  registerSubagentWaitTool(
    {
      registerTool(tool: unknown) {
        definition = tool as typeof definition;
      },
    } as any,
    () =>
      new SubagentWaitService(
        { list: async () => [] } as unknown as WorkstreamSupervisor,
        {} as CompletionInbox,
      ),
  );
  const controller = new AbortController();
  controller.abort();

  const result = await definition?.execute("wait-1", {}, controller.signal);

  assert.equal(result?.isError, false);
  assert.equal(result?.terminate, true);
  assert.equal(result?.details.interrupted, true);
  assert.equal(result?.details.workersAndInboxUnchanged, true);
  assert.equal(
    result?.content[0]?.text,
    "Wait interrupted; workers and completion records were left unchanged.",
  );
  assert.equal(definition?.renderShell, "self");
  assert.deepEqual(
    definition?.renderCall?.({}, plainTheme, {}).render(120),
    [],
  );
  assert.deepEqual(
    definition
      ?.renderResult?.(result, { isPartial: false }, plainTheme, {})
      .render(120),
    [],
  );
  assert.deepEqual(
    definition
      ?.renderResult?.(
        {
          content: [{ type: "text", text: "Waited worker reports:\n\nDone." }],
          details: {},
        },
        { isPartial: false },
        plainTheme,
        {},
      )
      .render(120)
      .map((line) => line.trimEnd()),
    ["Waited worker reports:", "", "Done."],
  );
});

test("wait retains a completion that settles during its implicit snapshot", async () => {
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
      terminalStatus: "settled",
      handoff: `Bounded ${manifest.kind} report for ${manifest.id}.`,
      artifactReferences: [],
      sourceCustomType: "pi-tools:subagent-test-handoff",
      sourceDetails: { workstreamId: manifest.id },
    });
    return { status: "settled" };
  });
  const wait = new SubagentWaitService(supervisor, inbox);
  const controller = new AbortController();
  let waiting: Promise<Awaited<ReturnType<typeof wait.wait>>> | undefined;
  let researchId: string | undefined;
  let taskId: string | undefined;

  try {
    const research = await supervisor.launch({
      kind: "research",
      brief: "Complete while the parent snapshots.",
      policy,
    });
    const task = await supervisor.launch({
      kind: "task",
      brief: "Remain live after research completes.",
      policy,
    });
    researchId = research.id;
    taskId = task.id;
    await tick();

    const isLive = supervisor.isLive.bind(supervisor);
    let settleDuringSnapshot = true;
    supervisor.isLive = async (id: string) => {
      if (settleDuringSnapshot) {
        settleDuringSnapshot = false;
        sessions[0]?.settle();
        await supervisor.waitForSettlement(research.id);
      }
      return isLive(id);
    };

    waiting = wait.wait(undefined, controller.signal);
    const result = await Promise.race([
      waiting.then((value) => ({ value })),
      new Promise<{ timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), 100),
      ),
    ]);

    assert.equal("timedOut" in result, false);
    if (!("value" in result)) throw new Error("Wait unexpectedly timed out.");
    assert.deepEqual(result.value.workstreamIds, [research.id]);
    assert.deepEqual(
      result.value.reports.map((report) => report.workstreamId),
      [research.id],
    );
    assert.equal(await supervisor.isLive(task.id), true);
    assert.equal((await inbox.listUnconsumed()).length, 0);
  } finally {
    controller.abort();
    sessions.forEach((session) => session.settle());
    await Promise.allSettled([
      waiting ?? Promise.resolve(),
      ...(researchId ? [supervisor.waitForSettlement(researchId)] : []),
      ...(taskId ? [supervisor.waitForSettlement(taskId)] : []),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});

test("wait returns when one snapshot worker is actionable and leaves later work untouched", async () => {
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
  let consumedIds: string[] | undefined;
  const wait = new SubagentWaitService(supervisor, inbox, (reports) => {
    consumedIds = reports.map((report) => report.id);
  });

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
    const result = await waiting;

    assert.deepEqual(result.workstreamIds, [task.id]);
    assert.equal(result.reports.length, 1);
    assert.deepEqual(
      consumedIds,
      result.reports.map((report) => report.id),
    );
    assert.deepEqual(
      result.reports.map((report) => report.deliveryState),
      ["consumed"],
    );
    assert.equal(await supervisor.isLive(research.id), true);
    assert.equal(await supervisor.isLive(later.id), true);
    assert.equal(
      (await inbox.list()).filter(
        (record) => record.deliveryState === "consumed",
      ).length,
      1,
    );

    sessions[1]?.settle();
    sessions[2]?.settle();
    await supervisor.waitForSettlement(research.id);
    await supervisor.waitForSettlement(later.id);
    const delivery = new CompletionInboxDelivery(
      { sendMessage() {} } as any,
      inbox,
    );
    assert.equal(await delivery.schedule(), true);
    const records = await inbox.list();
    assert.deepEqual(
      records
        .filter((record) => record.deliveryState === "scheduled")
        .map((record) => record.workstreamId)
        .sort(),
      [research.id, later.id].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wait handles paused, cancelled, failed, and interrupted snapshot workers", async () => {
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
    const readyResult = await wait.wait(undefined);
    assert.deepEqual(readyResult.workstreamIds, [completed.id]);
    assert.equal(readyResult.reports[0]?.workstreamId, completed.id);
    assert.deepEqual(readyResult.failures, []);
    assert.equal((await inbox.listUnconsumed()).length, 0);
    await assert.rejects(wait.wait([completed.id]), /only accepts actionable/);

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

    const paused = await supervisor.launch({
      kind: "task",
      brief: "Require explicit resume after recovery.",
      policy,
    });
    await tick();
    await supervisor.pause(paused.id, "Simulated crash recovery.");
    const pausedResult = await wait.wait(undefined);
    assert.deepEqual(pausedResult.workstreamIds, [paused.id]);
    assert.deepEqual(pausedResult.reports, []);
    assert.equal((await inbox.listUnconsumed()).length, 0);

    const cancelledDuringWait = await supervisor.launch({
      kind: "task",
      brief: "Cancel without a completion handoff.",
      policy,
    });
    const reportAfterCancel = await supervisor.launch({
      kind: "task",
      brief: "Finish after its peer is cancelled.",
      policy,
    });
    await tick();
    const cancelWait = wait.wait([
      cancelledDuringWait.id,
      reportAfterCancel.id,
    ]);
    await supervisor.cancel(cancelledDuringWait.id);
    sessions[4]?.settle();
    const cancelResult = await cancelWait;
    assert.deepEqual(cancelResult.workstreamIds, [reportAfterCancel.id]);
    assert.deepEqual(
      cancelResult.reports.map((report) => report.workstreamId),
      [reportAfterCancel.id],
    );

    const running = await supervisor.launch({
      kind: "task",
      brief: "Keep running when the parent stops waiting.",
      policy,
    });
    await tick();
    const controller = new AbortController();
    const interrupted = wait.wait([running.id], controller.signal);
    await tick();
    controller.abort();
    await assert.rejects(interrupted, /was cancelled/);
    assert.equal(await supervisor.isLive(running.id), true);
    assert.equal((await inbox.listUnconsumed()).length, 0);
    sessions[5]?.settle();
    await supervisor.waitForSettlement(running.id);
    assert.equal((await supervisor.get(running.id))?.status, "needs_decision");
    assert.equal((await inbox.listUnconsumed()).length, 1);
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
    const stillRunning = await supervisor.launch({
      kind: "task",
      brief: "Remain live when a peer fails.",
      policy,
    });
    await tick();
    const failureWait = wait.wait([failing.id, stillRunning.id]);
    await tick();
    sessions[6]?.fail("intentional failure");
    const failureResult = await failureWait;
    assert.deepEqual(failureResult.workstreamIds, [failing.id]);
    assert.deepEqual(failureResult.reports, []);
    assert.deepEqual(failureResult.failures, [
      {
        workstreamId: failing.id,
        status: "failed",
        detail: "intentional failure",
      },
    ]);
    assert.equal((await supervisor.get(failing.id))?.status, "failed");
    assert.equal(await supervisor.isLive(stillRunning.id), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
