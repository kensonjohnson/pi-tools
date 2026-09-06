import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

type AgentMessage = AgentSession["messages"][number];
import type { SubagentLaunchPolicy } from "./launch-policy.ts";
import { settingsRegistry } from "../../lib/pi-tools-config.ts";
import { SUBAGENT_SETTINGS } from "./settings.ts";
import {
  CompletionInbox,
  CompletionInboxDelivery,
  type CompletionInboxRecord,
} from "./completion-inbox.ts";
import {
  buildFocusedFollowUp,
  buildTaskBrief,
  TaskWorkstreamService,
  TASK_CONTROL_TIMELINE_ENTRY_TYPE,
  WorkstreamsWidget,
  TASK_HANDOFF_MESSAGE_TYPE,
  TASK_TIMELINE_ENTRY_TYPE,
} from "./task-workstreams.ts";
import type { WorkerSession } from "./supervisor.ts";
import { WorkstreamSupervisor } from "./supervisor.ts";

class FakeWorkerSession {
  readonly sessionFile: string;
  messages: AgentMessage[] = [];
  prompts: string[] = [];
  private listeners: Array<(event: AgentSessionEvent) => void> = [];
  private runs: Array<{ resolve: () => void; reject: (error: Error) => void }> =
    [];

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
    return new Promise<void>((resolve, reject) =>
      this.runs.push({ resolve, reject }),
    );
  }

  steer(): Promise<void> {
    return Promise.resolve();
  }

  followUp(text: string): Promise<void> {
    this.prompts.push(`queued:${text}`);
    return Promise.resolve();
  }

  abort(): Promise<void> {
    return Promise.resolve();
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  dispose(): void {}

  settle(run = this.runs.length - 1): void {
    this.runs[run]?.resolve();
  }
}

class DelayedCompletionInbox extends CompletionInbox {
  private delayedRead:
    | {
        started: () => void;
        resume: Promise<void>;
      }
    | undefined;

  delayNextRead(): {
    waitUntilStarted: Promise<void>;
    release(): void;
  } {
    let started!: () => void;
    let release!: () => void;
    const waitUntilStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.delayedRead = { started, resume };
    return { waitUntilStarted, release };
  }

  override async listUnconsumed(): Promise<CompletionInboxRecord[]> {
    const records = await super.listUnconsumed();
    const delayedRead = this.delayedRead;
    if (!delayedRead) return records;
    this.delayedRead = undefined;
    delayedRead.started();
    await delayedRead.resume;
    return records;
  }
}

const policy: SubagentLaunchPolicy = {
  maxConcurrentWorkers: 2,
  model: {
    model: { provider: "test", id: "worker", name: "Worker" } as any,
    source: "inherit",
  },
};

function assistantReport(status: string, outcome: string): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `<task-worker-report>\n{"status":"${status}","outcome":"${outcome}","files":["extensions/subagents/task-workstreams.ts"],"verification":["npm run test:subagents: pass"],"nextAction":"Review the bounded handoff.","blocker":"Need a decision when applicable."}\n</task-worker-report>`,
      },
    ],
    timestamp: Date.now(),
  } as AgentMessage;
}

test("animates only running workstreams and disposes its spinner timer", () => {
  const timers = new Map<number, () => void>();
  const cleared: number[] = [];
  const scheduler = {
    setInterval(callback: () => void, milliseconds: number) {
      assert.equal(milliseconds, 80);
      const id = timers.size + 1;
      timers.set(id, callback);
      return id as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(timer: ReturnType<typeof setInterval>) {
      const id = timer as unknown as number;
      cleared.push(id);
      timers.delete(id);
    },
  };
  let renders = 0;
  const widget = new WorkstreamsWidget(
    { requestRender: () => renders++ } as any,
    { fg: (_color: string, text: string) => text },
    [
      { text: "task active objective · running", status: "running" },
      { text: "task paused objective · paused", status: "paused" },
      {
        text: "queued · inbox objective",
        status: "settled",
      },
    ],
    scheduler,
  );

  const frames = [
    "⠁",
    "⠂",
    "⠄",
    "⡀",
    "⡈",
    "⡐",
    "⡠",
    "⣀",
    "⣁",
    "⣂",
    "⣄",
    "⣌",
    "⣔",
    "⣤",
    "⣥",
    "⣦",
    "⣮",
    "⣶",
    "⣷",
    "⣿",
    "⡿",
    "⠿",
    "⢟",
    "⠟",
    "⡛",
    "⠛",
    "⠫",
    "⢋",
    "⠋",
    "⠍",
    "⡉",
    "⠉",
    "⠑",
    "⠡",
    "⢁",
  ];

  assert.equal(timers.size, 1);
  assert.equal(
    widget.render(240)[1],
    `${frames[0]} task active objective · running`,
  );
  assert.equal(widget.render(240)[2], "task paused objective · paused");
  assert.equal(widget.render(240)[3], "queued · inbox objective");

  for (const frame of frames.slice(1)) {
    timers.get(1)?.();
    assert.equal(
      widget.render(240)[1],
      `${frame} task active objective · running`,
    );
  }
  assert.equal(renders, frames.length - 1);

  timers.get(1)?.();
  assert.equal(renders, frames.length);
  assert.equal(
    widget.render(240)[1],
    `${frames[0]} task active objective · running`,
  );

  widget.dispose();
  assert.deepEqual(cleared, [1]);
  assert.equal(timers.size, 0);
  widget.dispose();
  assert.deepEqual(cleared, [1]);

  const staticWidget = new WorkstreamsWidget(
    { requestRender() {} } as any,
    { fg: (_color: string, text: string) => text },
    [{ text: "task paused objective · paused", status: "paused" }],
    scheduler,
  );
  assert.equal(timers.size, 0);
  staticWidget.dispose();
  assert.deepEqual(cleared, [1]);
});

test("renders only concise thinking and tool lifecycle tail rows", () => {
  const timers = new Map<number, () => void>();
  const widget = new WorkstreamsWidget(
    { requestRender() {} } as any,
    { fg: (_color: string, text: string) => text },
    [
      {
        text: "running · inspect the flow",
        status: "running",
        events: [
          {
            kind: "thinking",
            state: "complete",
            text: "Thinking: Inspecting worker state · Updating focused tests",
          },
          {
            kind: "tool",
            state: "success",
            text: "Reading path/to/file.ts",
          },
          {
            kind: "thinking",
            state: "active",
            text: "Thinking: Comparing test results",
          },
          {
            kind: "tool",
            state: "failed",
            text: "Editing path/to/file.md",
          },
        ],
      },
    ],
    {
      setInterval(callback: () => void) {
        timers.set(1, callback);
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval() {
        timers.clear();
      },
    },
  );

  assert.deepEqual(widget.render(240), [
    "Subagent workstreams",
    "⠁ running · inspect the flow",
    "  ✓ Thinking: Inspecting worker state · Updating focused tests",
    "  ✓ Reading path/to/file.ts",
    "  ⠁ Thinking: Comparing test results",
    "  ! Editing path/to/file.md",
  ]);
  const rendered = widget.render(240).join("\n");
  assert.doesNotMatch(rendered, /tool result/i);
  assert.doesNotMatch(rendered, /\*\*/);
  widget.dispose();
  assert.equal(timers.size, 0);
});

test("limits live progress rows to the configured output tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-task-workstream-"));
  const session = new FakeWorkerSession(join(root, "worker.jsonl"));
  const supervisor = new WorkstreamSupervisor({
    cwd: root,
    rootDirectory: join(root, "subagents"),
    createSession: async () => session as unknown as WorkerSession,
    observeGit: async () => ({}),
  });
  const service = new TaskWorkstreamService(
    { appendEntry() {} },
    supervisor,
    root,
    new CompletionInbox(join(root, "subagents")),
    1,
  );

  try {
    const workstream = await supervisor.launch({
      kind: "task",
      brief: buildTaskBrief({ objective: "Inspect the tail", scope: "Tests" }),
      policy,
    });
    await Promise.resolve();
    session.emit({
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: {},
    } as AgentSessionEvent);
    session.emit({
      type: "tool_execution_end",
      toolCallId: "read-1",
      toolName: "read",
      result: "raw result",
      isError: false,
    } as AgentSessionEvent);
    session.emit({
      type: "tool_execution_start",
      toolCallId: "bash-1",
      toolName: "bash",
      args: {},
    } as AgentSessionEvent);
    await service.refreshWidget({
      ui: {
        setWidget(_key: string, content: unknown) {
          const widget = (content as any)(
            { requestRender() {} },
            { fg: (_color: string, text: string) => text },
          );
          const lines = widget.render(240).join("\n");
          assert.match(lines, /Tool: bash/);
          assert.doesNotMatch(lines, /Tool: read|raw result/);
          widget.dispose();
        },
      },
    } as any);
    assert.equal((await supervisor.get(workstream.id))?.status, "running");
  } finally {
    await supervisor.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("does not restore a queued row when acknowledgement overtakes an older widget refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-task-workstream-"));
  const session = new FakeWorkerSession(join(root, "worker.jsonl"));
  const supervisor = new WorkstreamSupervisor({
    cwd: root,
    rootDirectory: join(root, "subagents"),
    createSession: async () => session as unknown as WorkerSession,
    observeGit: async () => ({}),
  });
  const inbox = new DelayedCompletionInbox(join(root, "subagents"));
  const service = new TaskWorkstreamService(
    { appendEntry() {} },
    supervisor,
    root,
    inbox,
  );
  const sent: any[] = [];
  const delivery = new CompletionInboxDelivery(
    {
      sendMessage(message) {
        sent.push(message);
      },
    } as any,
    inbox,
  );
  let widget: unknown;
  const ctx = {
    ui: {
      setWidget(_key: string, content: unknown) {
        widget = content;
      },
    },
  } as any;

  try {
    const workstream = await supervisor.launch({
      kind: "task",
      brief: buildTaskBrief({
        objective: "Remove acknowledged completion rows.",
        scope: "Widget refresh regression test.",
      }),
      policy,
    });
    await Promise.resolve();
    session.messages = [assistantReport("completed", "Completion recorded.")];
    session.settle();
    await supervisor.waitForSettlement(workstream.id);
    assert.equal(await delivery.schedule(), true);

    const delayed = inbox.delayNextRead();
    const staleRefresh = service.refreshWidget(ctx);
    await delayed.waitUntilStarted;

    assert.equal(
      await delivery.acknowledgeMessage({
        ...sent[0],
        role: "custom",
        timestamp: Date.now(),
      } as AgentMessage),
      1,
    );
    await service.refreshWidget(ctx);
    assert.equal(widget, undefined);

    delayed.release();
    await staleRefresh;
    assert.equal(widget, undefined);
  } finally {
    await supervisor.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps attention rows after delivery and clears them only after explicit resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-task-workstream-"));
  const sessions: FakeWorkerSession[] = [];
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
  const inbox = new CompletionInbox(join(root, "subagents"));
  const sent: any[] = [];
  const service = new TaskWorkstreamService(
    {
      appendEntry() {},
      sendMessage(message) {
        sent.push(message);
      },
    } as any,
    supervisor,
    root,
    inbox,
  );
  const widgetContext = {
    ui: {
      setWidget(_key: string, content: unknown) {
        widget = content;
      },
    },
  } as any;
  let widget: unknown;

  const renderWidget = (): string => {
    if (typeof widget !== "function") return "";
    const instance = widget(
      { requestRender() {} },
      { fg: (_color: string, text: string) => text },
    );
    try {
      return instance.render(240).join("\n");
    } finally {
      instance.dispose();
    }
  };

  const completeAttentionWorkstream = async (outcome: string) => {
    const workstream = await supervisor.launch({
      kind: "task",
      brief: buildTaskBrief({
        objective: "Retain an attention-needed row.",
        scope: "Explicit resolution regression coverage.",
      }),
      policy,
    });
    await Promise.resolve();
    sessions.at(-1)!.messages = [assistantReport("needs-decision", outcome)];
    sessions.at(-1)!.settle();
    await supervisor.waitForSettlement(workstream.id);
    return workstream;
  };

  try {
    const acknowledged = await completeAttentionWorkstream(
      "Acknowledge this decision handoff.",
    );
    const delivery = new CompletionInboxDelivery(
      {
        sendMessage(message) {
          sent.push(message);
        },
      } as any,
      inbox,
    );
    assert.equal(await delivery.schedule(), true);
    assert.equal(sent.length, 1);
    await service.refreshWidget(widgetContext);
    assert.match(renderWidget(), /queued ·/);
    assert.equal(
      await delivery.acknowledgeMessage({
        ...sent[0],
        role: "custom",
        timestamp: Date.now(),
      } as AgentMessage),
      1,
    );
    await service.refreshWidget(widgetContext);
    assert.match(renderWidget(), /needs decision ·/);
    assert.equal(
      (await supervisor.get(acknowledged.id))?.status,
      "needs_decision",
    );

    await service.control({} as any, {
      workstreamId: acknowledged.id,
      action: "resolve",
      message: "Parent handled the acknowledged decision.",
    });
    await service.refreshWidget(widgetContext);
    assert.equal(widget, undefined);
    assert.equal((await supervisor.get(acknowledged.id))?.status, "settled");

    const consumed = await completeAttentionWorkstream(
      "Consume this decision handoff before resolution.",
    );
    const consumedRecord = (await inbox.listUnconsumed()).find(
      (record) => record.workstreamId === consumed.id,
    );
    assert.ok(consumedRecord);
    await inbox.consume([consumedRecord.id]);
    await service.refreshWidget(widgetContext);
    assert.match(renderWidget(), /needs decision ·/);
    await service.control({} as any, {
      workstreamId: consumed.id,
      action: "resolve",
      message: "Parent handled the consumed decision.",
    });
    await service.refreshWidget(widgetContext);
    assert.equal(widget, undefined);

    const pending = await completeAttentionWorkstream(
      "Keep this unresolved handoff deliverable.",
    );
    await service.control({} as any, {
      workstreamId: pending.id,
      action: "resolve",
      message: "Parent resolved while retaining delivery.",
    });
    const pendingRecord = (await inbox.listUnconsumed()).find(
      (record) => record.workstreamId === pending.id,
    );
    assert.ok(pendingRecord);
    assert.equal(pendingRecord.deliveryState, "pending");
    await service.refreshWidget(widgetContext);
    assert.match(renderWidget(), /queued ·/);

    const report = await service.currentReport(acknowledged.id);
    assert.equal(report.report?.sequence, 1);
    assert.equal(report.report?.status, "needs-decision");
    const journal = await readFile(
      join(root, "subagents", acknowledged.id, "journal.md"),
      "utf8",
    );
    assert.match(
      journal,
      /settled: Parent handled the acknowledged decision\./,
    );

    const reloadedSupervisor = new WorkstreamSupervisor({
      cwd: root,
      rootDirectory: join(root, "subagents"),
      observeGit: async () => ({}),
    });
    const reloadedTasks = new TaskWorkstreamService(
      { appendEntry() {} },
      reloadedSupervisor,
      root,
      new CompletionInbox(join(root, "subagents")),
    );
    assert.equal(
      (await reloadedSupervisor.get(acknowledged.id))?.status,
      "settled",
    );
    await reloadedTasks.refreshWidget(widgetContext);
    assert.match(renderWidget(), /queued ·/);
    await inbox.consume([pendingRecord.id]);
    await reloadedTasks.refreshWidget(widgetContext);
    assert.equal(widget, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains task detail locally and creates one durable inbox handoff per completed persistent run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-task-workstream-"));
  const session = new FakeWorkerSession(join(root, "worker.jsonl"));
  const entries: Array<{ type: string; data: unknown }> = [];
  const messages: Array<{ content: string; options: unknown }> = [];
  let widget: unknown;
  let createdSessions = 0;
  const supervisor = new WorkstreamSupervisor({
    cwd: root,
    rootDirectory: join(root, "subagents"),
    createSession: async () =>
      (++createdSessions === 1
        ? session
        : new FakeWorkerSession(
            join(root, "blocker.jsonl"),
          )) as unknown as WorkerSession,
    observeGit: async () => ({ branch: "main", commit: "abc123" }),
  });
  const inbox = new CompletionInbox(join(root, "subagents"));
  const service = new TaskWorkstreamService(
    {
      appendEntry(type, data) {
        entries.push({ type, data });
      },
      sendMessage(message, options) {
        messages.push({ content: String(message.content), options });
      },
    },
    supervisor,
    root,
    inbox,
  );

  try {
    const brief = buildTaskBrief({
      objective: "Add bounded task-worker handoffs.",
      scope: "Only extensions/subagents; no external actions.",
      context: "The supervisor already persists worker sessions.",
    });
    assert.match(brief, /Task-worker brief/);
    assert.match(brief, /task-worker-report/);
    const workstream = await supervisor.launch({ kind: "task", brief, policy });
    await Promise.resolve();
    session.emit({
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: {},
    } as AgentSessionEvent);
    await supervisor.flush();
    await service.refreshWidget({
      ui: {
        setWidget(_key: string, content: unknown) {
          widget = content;
        },
      },
    } as any);
    const runningWidget = (widget as any)(
      { requestRender() {} },
      { fg: (_color: string, text: string) => text },
    );
    const widgetLines = runningWidget.render(240);
    assert.match(
      widgetLines.join("\n"),
      /running · Add bounded task-worker handoffs/,
    );
    assert.doesNotMatch(widgetLines.join("\n"), /tool_started|Worker started/);
    runningWidget.dispose();
    session.messages = [
      assistantReport("needs-decision", "A product choice is required."),
    ];
    session.settle();
    await supervisor.waitForSettlement(workstream.id);

    const first = await service.currentReport(workstream.id);
    assert.equal(first.report?.status, "needs-decision");
    assert.equal(
      (await supervisor.get(workstream.id))?.status,
      "needs_decision",
    );
    assert.equal(first.report?.sequence, 1);
    assert.match(first.report?.finalAssistantText ?? "", /product choice/);
    assert.equal(messages.length, 0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.type, TASK_TIMELINE_ENTRY_TYPE);
    const firstInbox = await inbox.listUnconsumed();
    assert.equal(firstInbox.length, 1);
    assert.match(firstInbox[0]?.handoff ?? "", /needs a decision/);
    assert.equal(firstInbox[0]?.deliveryState, "pending");
    await service.control({} as any, {
      workstreamId: workstream.id,
      action: "checkpoint",
      message: "Retain the decision context.",
    });
    assert.equal(entries[1]?.type, TASK_CONTROL_TIMELINE_ENTRY_TYPE);

    const followUp = buildFocusedFollowUp(
      "Choose the smallest compatible design.",
    );
    assert.match(followUp, /existing task context/);
    settingsRegistry.register(SUBAGENT_SETTINGS);
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(
      join(root, ".pi", "pi-tools.json"),
      JSON.stringify({
        version: 1,
        extensions: {
          subagents: {
            enabled: true,
            maxConcurrentWorkers: 1,
            models: { task: "inherit" },
          },
        },
      }),
    );
    const followUpContext = {
      cwd: root,
      isProjectTrusted: () => true,
      model: policy.model.model,
    } as any;
    const blocker = await supervisor.launch({
      kind: "research",
      brief: "Occupy the configured worker slot.",
      policy: { ...policy, maxConcurrentWorkers: 1 },
    });
    await assert.rejects(
      service.followUp(followUpContext, {
        workstreamId: workstream.id,
        focus: "Must not exceed the project limit.",
      }),
      /concurrency limit \(1\)/,
    );
    assert.equal(
      (await supervisor.get(workstream.id))?.status,
      "needs_decision",
    );
    await supervisor.cancel(blocker.id);
    await service.followUp(followUpContext, {
      workstreamId: workstream.id,
      focus: "Choose the smallest compatible design.",
    });
    await Promise.resolve();
    session.messages = [
      assistantReport("completed", "Implemented the selected design."),
    ];
    session.settle();
    await supervisor.waitForSettlement(workstream.id);

    const second = await service.currentReport(workstream.id);
    assert.equal(second.report?.status, "completed");
    assert.equal(second.report?.sequence, 2);
    assert.equal(messages.length, 0);
    assert.equal(entries.length, 3);
    assert.equal((await supervisor.get(workstream.id))?.status, "settled");
    assert.equal((await inbox.listUnconsumed()).length, 2);
    await service.refreshWidget({
      ui: {
        setWidget(_key: string, content: unknown) {
          widget = content;
        },
      },
    } as any);
    const settledWidget = (widget as any)(
      { requestRender() {} },
      { fg: (_color: string, text: string) => text },
    );
    const settledWidgetLines = settledWidget.render(24);
    assert.match(settledWidgetLines[1] ?? "", /^queued ·/);
    assert.doesNotMatch(
      settledWidgetLines.join("\n"),
      new RegExp(workstream.id),
    );
    assert.doesNotMatch(
      settledWidgetLines.join("\n"),
      /tool_started|Worker started/,
    );
    settledWidget.dispose();
    assert.equal(
      (entries[0]?.data as { workstreamId?: string }).workstreamId,
      workstream.id,
    );
    assert.equal(TASK_HANDOFF_MESSAGE_TYPE, "pi-tools:subagent-task-handoff");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
