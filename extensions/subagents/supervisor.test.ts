import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentLaunchPolicy } from "./launch-policy.ts";
import {
  type WorkerSession,
  type WorkerSessionFactoryOptions,
  WorkstreamSupervisor,
} from "./supervisor.ts";

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

function createFakeSession(
  options: WorkerSessionFactoryOptions,
  sessions: FakeWorkerSession[],
): WorkerSession {
  const session = new FakeWorkerSession(
    join(options.sessionDirectory, `worker-${sessions.length}.jsonl`),
  );
  sessions.push(session);
  return session as unknown as WorkerSession;
}

// Every attempt either reaches setup or is refused. Hold admitted setup until
// all attempts have been counted, without sleeps or filesystem timing guesses.
function setupGate(attempts: number) {
  let arrivals = 0;
  let entered = 0;
  let ready!: () => void;
  let release!: () => void;
  const allArrived = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrive = () => {
    if (++arrivals === attempts) ready();
  };
  return {
    allArrived,
    release,
    get entered() {
      return entered;
    },
    async enter() {
      entered++;
      arrive();
      await released;
    },
    refused(error: unknown): never {
      arrive();
      throw error;
    },
  };
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
    assert.deepEqual(events, [
      "started",
      "progress",
      "progress",
      "tool_started",
      "tool_finished",
    ]);

    sessions[0].settle();
    await supervisor.waitForSettlement(workstream.id);
    assert.equal((await supervisor.get(workstream.id))?.status, "settled");
  });
});

test("captures bounded thinking and tool lifecycle progress without tool results", async () => {
  await withSupervisor(async ({ supervisor, sessions }) => {
    const workstream = await supervisor.launch({
      kind: "task",
      brief: "Inspect progress.",
      policy,
    });
    sessions[0].emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 1 },
    } as AgentSessionEvent);
    assert.deepEqual(supervisor.progressEvents(workstream.id), [
      {
        id: "thinking:1",
        kind: "thinking",
        state: "active",
        text: "Thinking…",
      },
    ]);
    sessions[0].emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 1 },
    } as AgentSessionEvent);
    assert.deepEqual(supervisor.progressEvents(workstream.id), []);

    sessions[0].emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 2 },
    } as AgentSessionEvent);
    sessions[0].emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 2,
        delta: " \n\t ",
      },
    } as AgentSessionEvent);
    sessions[0].emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 2 },
    } as AgentSessionEvent);
    assert.deepEqual(supervisor.progressEvents(workstream.id), []);

    sessions[0].emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    } as AgentSessionEvent);
    sessions[0].emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "Inspecting the worker state.",
      },
    } as AgentSessionEvent);
    sessions[0].emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
    } as AgentSessionEvent);
    sessions[0].emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "path/to/file.ts" },
    } as AgentSessionEvent);
    sessions[0].emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: "raw tool result must not appear",
      isError: false,
    } as AgentSessionEvent);
    sessions[0].emit({
      type: "tool_execution_start",
      toolCallId: "tool-2",
      toolName: "bash",
      args: { command: "rg  something --flag" },
    } as AgentSessionEvent);
    sessions[0].emit({
      type: "tool_execution_end",
      toolCallId: "tool-2",
      toolName: "bash",
      result: "raw failed result must not appear",
      isError: true,
    } as AgentSessionEvent);
    sessions[0].emit({
      type: "tool_execution_start",
      toolCallId: "tool-3",
      toolName: "write",
      args: { path: "path/to/file.md" },
    } as AgentSessionEvent);
    sessions[0].emit({
      type: "tool_execution_end",
      toolCallId: "tool-3",
      toolName: "write",
      result: "raw tool result must not appear",
      isError: false,
    } as AgentSessionEvent);
    sessions[0].emit({
      type: "tool_execution_start",
      toolCallId: "tool-4",
      toolName: "edit",
      args: { path: "path/to/file.md" },
    } as AgentSessionEvent);
    sessions[0].emit({
      type: "tool_execution_end",
      toolCallId: "tool-4",
      toolName: "edit",
      result: "raw tool result must not appear",
      isError: false,
    } as AgentSessionEvent);
    sessions[0].emit({
      type: "tool_execution_start",
      toolCallId: "tool-5",
      toolName: "brave_search",
      args: { query: "do not render raw arguments" },
    } as AgentSessionEvent);
    sessions[0].emit({
      type: "tool_execution_end",
      toolCallId: "tool-5",
      toolName: "brave_search",
      result: "raw tool result must not appear",
      isError: false,
    } as AgentSessionEvent);

    assert.deepEqual(supervisor.progressEvents(workstream.id), [
      {
        id: "thinking:0",
        kind: "thinking",
        state: "complete",
        text: "Thinking: Inspecting the worker state.",
      },
      {
        id: "tool:tool-1",
        kind: "tool",
        state: "success",
        text: "Reading path/to/file.ts",
      },
      {
        id: "tool:tool-2",
        kind: "tool",
        state: "failed",
        text: "Bash: rg something --flag",
      },
      {
        id: "tool:tool-3",
        kind: "tool",
        state: "success",
        text: "Writing path/to/file.md",
      },
      {
        id: "tool:tool-4",
        kind: "tool",
        state: "success",
        text: "Editing path/to/file.md",
      },
      {
        id: "tool:tool-5",
        kind: "tool",
        state: "success",
        text: "Tool: brave_search",
      },
    ]);
    sessions[0].emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    } as AgentSessionEvent);
    sessions[0].emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
    } as AgentSessionEvent);
    assert.deepEqual(
      supervisor
        .progressEvents(workstream.id)
        .filter((event) => event.kind === "thinking"),
      [
        {
          id: "thinking:0",
          kind: "thinking",
          state: "complete",
          text: "Thinking: Inspecting the worker state.",
        },
      ],
    );
    sessions[0].emit({
      type: "tool_execution_start",
      toolCallId: "tool-6",
      toolName: "bash",
      args: { command: `\u001b${"x".repeat(200)}` },
    } as AgentSessionEvent);
    const bounded = supervisor.progressEvents(workstream.id).at(-1);
    assert.equal(bounded?.text.length, 180);
    assert.match(bounded?.text ?? "", /^Bash: x+…$/);
    assert.doesNotMatch(bounded?.text ?? "", /\u001b/);
    sessions[0].settle();
    await supervisor.waitForSettlement(workstream.id);
  });
});

test("renders whitespace-delimited OpenAI reasoning summaries as plain-text parts", async () => {
  await withSupervisor(async ({ supervisor, sessions }) => {
    const workstream = await supervisor.launch({
      kind: "task",
      brief: "Inspect summary rendering.",
      policy,
    });
    sessions[0].emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 3 },
    } as AgentSessionEvent);
    for (const delta of [
      "**Inspect",
      " the worker state.**",
      "\n\n",
      "**Update",
      " the focused tests.**",
    ]) {
      sessions[0].emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 3,
          delta,
        },
      } as AgentSessionEvent);
    }
    sessions[0].emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 3 },
    } as AgentSessionEvent);

    const thinking = supervisor
      .progressEvents(workstream.id)
      .filter((event) => event.kind === "thinking");
    assert.deepEqual(thinking, [
      {
        id: "thinking:3",
        kind: "thinking",
        state: "complete",
        text: "Thinking: Inspect the worker state. · Update the focused tests.",
      },
    ]);
    assert.doesNotMatch(thinking[0]?.text ?? "", /\*\*/);

    sessions[0].settle();
    await supervisor.waitForSettlement(workstream.id);
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

test(
  "reserves three slots before delayed Git observation across six mixed launches",
  { timeout: 10_000 },
  async () => {
    await withSupervisor(async ({ root }) => {
      const gate = setupGate(6);
      const sessions: FakeWorkerSession[] = [];
      const supervisor = new WorkstreamSupervisor({
        cwd: root,
        rootDirectory: join(root, "gated-launches"),
        observeGit: async () => {
          await gate.enter();
          return { branch: "main" };
        },
        createSession: async (options) => createFakeSession(options, sessions),
      });
      const resultsPromise = Promise.allSettled(
        Array.from({ length: 6 }, (_, index) =>
          supervisor
            .launch({
              kind: index % 2 === 0 ? "task" : "research",
              brief: `Concurrent launch ${index}.`,
              policy: { ...policy, maxConcurrentWorkers: 3 },
            })
            .catch(gate.refused),
        ),
      );
      await gate.allArrived;
      const admittedBeforeRelease = gate.entered;
      const sessionsBeforeRelease = sessions.length;
      gate.release();
      const results = await resultsPromise;
      const admitted = results.filter(
        (result) => result.status === "fulfilled",
      );
      const refused = results.filter((result) => result.status === "rejected");
      for (const session of sessions) session.settle();
      await Promise.all(
        admitted.map((result) => supervisor.waitForSettlement(result.value.id)),
      );

      assert.equal(admittedBeforeRelease, 3);
      assert.equal(sessionsBeforeRelease, 0);
      assert.equal(admitted.length, 3);
      assert.equal(refused.length, 3);
      for (const result of refused) {
        assert.match(
          String(result.reason),
          /concurrency limit \(3\) is reached/,
        );
      }
      assert.equal(sessions.length, 3);
      assert.equal((await supervisor.list()).length, 3);
      assert.deepEqual(
        new Set(admitted.map((result) => result.value.kind)),
        new Set(["task", "research"]),
      );
    });
  },
);

test(
  "reserves three slots before reopening six restored sessions concurrently",
  { timeout: 10_000 },
  async () => {
    await withSupervisor(async ({ root, supervisor }) => {
      const workstreams = [];
      for (let index = 0; index < 6; index++) {
        workstreams.push(
          await supervisor.launch({
            kind: index % 2 === 0 ? "task" : "research",
            brief: `Persisted worker ${index}.`,
            policy: { ...policy, maxConcurrentWorkers: 6 },
          }),
        );
      }
      await supervisor.shutdown();
      await Promise.all(
        workstreams.map((workstream) =>
          supervisor.waitForSettlement(workstream.id),
        ),
      );
      const gate = setupGate(6);
      const sessions: FakeWorkerSession[] = [];
      const reloaded = new WorkstreamSupervisor({
        cwd: root,
        rootDirectory: join(root, "subagents"),
        createSession: async (options) => {
          await gate.enter();
          return createFakeSession(options, sessions);
        },
      });
      const resultsPromise = Promise.allSettled(
        workstreams.map((workstream) =>
          reloaded
            .resume(workstream.id, { ...policy, maxConcurrentWorkers: 3 })
            .catch(gate.refused),
        ),
      );
      await gate.allArrived;
      const admittedBeforeRelease = gate.entered;
      gate.release();
      const results = await resultsPromise;
      const admitted = results.filter(
        (result) => result.status === "fulfilled",
      );
      const refused = results.filter((result) => result.status === "rejected");
      for (const session of sessions) session.settle();
      await Promise.all(
        admitted.map((result) => reloaded.waitForSettlement(result.value.id)),
      );

      assert.equal(admittedBeforeRelease, 3);
      assert.equal(admitted.length, 3);
      assert.equal(refused.length, 3);
      for (const result of refused) {
        assert.match(
          String(result.reason),
          /concurrency limit \(3\) is reached/,
        );
      }
      assert.equal(sessions.length, 3);
      assert.equal(
        (await reloaded.list()).filter(
          (manifest) => manifest.status === "paused",
        ).length,
        3,
      );
    });
  },
);

test(
  "refuses duplicate simultaneous resumes before opening a second session",
  { timeout: 10_000 },
  async () => {
    await withSupervisor(async ({ root, supervisor }) => {
      const workstream = await supervisor.launch({
        kind: "task",
        brief: "Resume once.",
        policy,
      });
      await supervisor.shutdown();
      await supervisor.waitForSettlement(workstream.id);
      const gate = setupGate(2);
      const sessions: FakeWorkerSession[] = [];
      const reloaded = new WorkstreamSupervisor({
        cwd: root,
        rootDirectory: join(root, "subagents"),
        createSession: async (options) => {
          await gate.enter();
          return createFakeSession(options, sessions);
        },
      });
      const resultsPromise = Promise.allSettled([
        reloaded.resume(workstream.id, policy).catch(gate.refused),
        reloaded.resume(workstream.id, policy).catch(gate.refused),
      ]);
      await gate.allArrived;
      const admittedBeforeRelease = gate.entered;
      gate.release();
      const results = await resultsPromise;
      for (const session of sessions) session.settle();
      await reloaded.waitForSettlement(workstream.id);

      assert.equal(admittedBeforeRelease, 1);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
      );
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].prompts.length, 1);
    });
  },
);

test("refuses inactive follow-up at capacity but permits live follow-up and later restart", async () => {
  await withSupervisor(async ({ supervisor, sessions }) => {
    const capOne = { ...policy, maxConcurrentWorkers: 1 };
    const inactive = await supervisor.launch({
      kind: "task",
      brief: "Finish first.",
      policy: capOne,
    });
    sessions[0].settle();
    await supervisor.waitForSettlement(inactive.id);
    await assert.rejects(
      supervisor.followUp(inactive.id, "Live-only delivery must not restart."),
      /not running; no follow-up was sent/,
    );
    assert.deepEqual(sessions[0].prompts, ["Finish first."]);
    const active = await supervisor.launch({
      kind: "research",
      brief: "Occupy the slot.",
      policy: capOne,
    });
    await supervisor.followUp(active.id, "Live-only delivery.");
    const before = await supervisor.get(inactive.id);
    await assert.rejects(
      supervisor.followUp(inactive.id, "Must not restart yet.", 1),
      /concurrency limit \(1\) is reached/,
    );
    assert.deepEqual(await supervisor.get(inactive.id), before);
    assert.deepEqual(sessions[0].prompts, ["Finish first."]);
    await supervisor.followUp(active.id, "Queue without another slot.", 1);
    assert.deepEqual(sessions[1].followUps, [
      "Live-only delivery.",
      "Queue without another slot.",
    ]);
    sessions[1].settle();
    await supervisor.waitForSettlement(active.id);
    const restarted = await supervisor.followUp(
      inactive.id,
      "Restart after settlement.",
      1,
    );
    assert.equal(restarted.status, "running");
    assert.equal(sessions.length, 2);
    sessions[0].settle();
    await supervisor.waitForSettlement(inactive.id);
    assert.deepEqual(sessions[0].prompts, [
      "Finish first.",
      "Restart after settlement.",
    ]);
  });
});

test("releases launch reservations after setup failures", async (t) => {
  for (const stage of [
    "observeGit",
    "createWorkstream",
    "createSession",
    "subscribe",
  ] as const) {
    await t.test(stage, async () => {
      await withSupervisor(async ({ root }) => {
        const rootDirectory = join(root, "failed-setup");
        const sessions: FakeWorkerSession[] = [];
        let fail = true;
        const supervisor = new WorkstreamSupervisor({
          cwd: root,
          rootDirectory,
          observeGit: async () => {
            if (fail && stage === "observeGit")
              throw new Error("Git setup failed");
            return {};
          },
          createSession: async (options) => {
            if (fail && stage === "createSession")
              throw new Error("Session setup failed");
            const session = createFakeSession(options, sessions);
            if (fail && stage === "subscribe") {
              session.subscribe = () => {
                throw new Error("Subscription setup failed");
              };
            }
            return session;
          },
        });
        if (stage === "createWorkstream")
          await writeFile(rootDirectory, "Not a directory.");
        const [failed] = await Promise.allSettled([
          supervisor.launch({
            kind: "task",
            brief: "Fail during setup.",
            policy: { ...policy, maxConcurrentWorkers: 1 },
          }),
        ]);
        if (failed.status === "fulfilled")
          assert.equal(failed.value.status, "failed");
        else assert.match(String(failed.reason), /setup failed|ENOTDIR|EEXIST/);
        if (stage === "createWorkstream") await rm(rootDirectory);
        fail = false;
        const next = await supervisor.launch({
          kind: "research",
          brief: "Use the released slot.",
          policy: { ...policy, maxConcurrentWorkers: 1 },
        });
        assert.equal(next.status, "running");
        sessions.at(-1)!.settle();
        await supervisor.waitForSettlement(next.id);
      });
    });
  }
});

test("releases a restored resume reservation when session creation fails", async () => {
  await withSupervisor(async ({ root, supervisor }) => {
    const workstream = await supervisor.launch({
      kind: "task",
      brief: "Restore after setup failure.",
      policy,
    });
    await supervisor.shutdown();
    await supervisor.waitForSettlement(workstream.id);
    const sessions: FakeWorkerSession[] = [];
    let fail = true;
    const reloaded = new WorkstreamSupervisor({
      cwd: root,
      rootDirectory: join(root, "subagents"),
      observeGit: async () => ({}),
      createSession: async (options) => {
        if (fail) throw new Error("Reopen setup failed");
        return createFakeSession(options, sessions);
      },
    });
    const capOne = { ...policy, maxConcurrentWorkers: 1 };
    await assert.rejects(
      reloaded.resume(workstream.id, capOne),
      /Reopen setup failed/,
    );
    assert.equal((await reloaded.get(workstream.id))?.status, "paused");
    fail = false;
    const next = await reloaded.launch({
      kind: "research",
      brief: "Use the released resume slot.",
      policy: capOne,
    });
    sessions[0].settle();
    await reloaded.waitForSettlement(next.id);
    const resumed = await reloaded.resume(workstream.id, capOne);
    assert.equal(resumed.status, "running");
    sessions[1].settle();
    await reloaded.waitForSettlement(workstream.id);
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
    await supervisor.followUp(
      workstream.id,
      "Then report the result.",
      policy.maxConcurrentWorkers,
    );
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
      supervisor.followUp(
        workstream.id,
        "Do not queue while paused.",
        policy.maxConcurrentWorkers,
      ),
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

test("resolves only blocked or needs-decision workstreams with durable parent detail", async () => {
  await withSupervisor(async ({ root, supervisor, sessions, events }) => {
    const blocked = await supervisor.launch({
      kind: "task",
      brief: "Wait for a parent decision.",
      policy,
    });
    await supervisor.markBlocked(
      blocked.id,
      "Worker needs a product decision.",
    );
    const beforeMissingDetail = await supervisor.get(blocked.id);
    const beforeMissingDetailJournal = await readFile(
      join(root, "subagents", blocked.id, "journal.md"),
      "utf8",
    );
    await assert.rejects(
      supervisor.resolve(blocked.id, "  \n\t"),
      /concise parent resolution detail is required/,
    );
    assert.deepEqual(await supervisor.get(blocked.id), beforeMissingDetail);
    assert.equal(
      await readFile(join(root, "subagents", blocked.id, "journal.md"), "utf8"),
      beforeMissingDetailJournal,
    );

    const resolved = await supervisor.resolve(
      blocked.id,
      "Parent selected the compatible implementation.",
    );
    assert.equal(resolved.status, "settled");
    assert.equal(events.at(-1), "settled");
    assert.equal(sessions[0]?.disposed, false);
    const journalAfterResolution = await readFile(
      join(root, "subagents", blocked.id, "journal.md"),
      "utf8",
    );
    assert.match(
      journalAfterResolution,
      /settled: Parent selected the compatible implementation\./,
    );
    await assert.rejects(
      supervisor.resolve(blocked.id, "A second parent decision."),
      /only blocked or needs_decision workstreams can be resolved/,
    );
    assert.equal(
      await readFile(join(root, "subagents", blocked.id, "journal.md"), "utf8"),
      journalAfterResolution,
    );

    sessions[0]?.settle();
    await supervisor.waitForSettlement(blocked.id);
    const needsDecision = await supervisor.launch({
      kind: "research",
      brief: "Wait for a research decision.",
      policy,
    });
    await supervisor.markNeedsDecision(
      needsDecision.id,
      "Research needs a parent choice.",
    );
    const resolvedNeedsDecision = await supervisor.resolve(
      needsDecision.id,
      "Parent accepted the cited tradeoff.",
    );
    assert.equal(resolvedNeedsDecision.status, "settled");

    const running = await supervisor.launch({
      kind: "task",
      brief: "Keep this worker running.",
      policy,
    });
    const beforeInvalidStatus = await supervisor.get(running.id);
    const beforeInvalidStatusJournal = await readFile(
      join(root, "subagents", running.id, "journal.md"),
      "utf8",
    );
    await assert.rejects(
      supervisor.resolve(running.id, "This is not valid yet."),
      /only blocked or needs_decision workstreams can be resolved/,
    );
    assert.deepEqual(await supervisor.get(running.id), beforeInvalidStatus);
    assert.equal(
      await readFile(join(root, "subagents", running.id, "journal.md"), "utf8"),
      beforeInvalidStatusJournal,
    );
    sessions[1]?.settle();
    sessions[2]?.settle();
    await supervisor.waitForSettlement(needsDecision.id);
    await supervisor.waitForSettlement(running.id);
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
