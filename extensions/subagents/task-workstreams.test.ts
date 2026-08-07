import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentLaunchPolicy } from "./launch-policy.ts";
import { CompletionInbox } from "./completion-inbox.ts";
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
            text: "Thinking: Inspecting worker state",
          },
          { kind: "tool", state: "success", text: "Tool: read" },
          { kind: "tool", state: "active", text: "Tool: bash" },
          { kind: "tool", state: "failed", text: "Tool: write" },
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
    "  Thinking: Inspecting worker state",
    "  ✓ Tool: read",
    "  ⠁ Tool: bash",
    "  ! Tool: write",
  ]);
  assert.doesNotMatch(widget.render(240).join("\n"), /tool result/i);
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

test("retains task detail locally and creates one durable inbox handoff per completed persistent run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-task-workstream-"));
  const session = new FakeWorkerSession(join(root, "worker.jsonl"));
  const entries: Array<{ type: string; data: unknown }> = [];
  const messages: Array<{ content: string; options: unknown }> = [];
  let widget: unknown;
  const supervisor = new WorkstreamSupervisor({
    cwd: root,
    rootDirectory: join(root, "subagents"),
    createSession: async () => session as unknown as WorkerSession,
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
    await service.followUp({
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
