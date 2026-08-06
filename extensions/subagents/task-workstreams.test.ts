import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentLaunchPolicy } from "./launch-policy.ts";
import {
  buildFocusedFollowUp,
  buildTaskBrief,
  TaskWorkstreamService,
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

test("retains task detail locally and emits one bounded handoff per completed persistent run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-task-workstream-"));
  const session = new FakeWorkerSession(join(root, "worker.jsonl"));
  const entries: Array<{ type: string; data: unknown }> = [];
  const messages: Array<{ content: string; options: unknown }> = [];
  const supervisor = new WorkstreamSupervisor({
    cwd: root,
    rootDirectory: join(root, "subagents"),
    createSession: async () => session as unknown as WorkerSession,
    observeGit: async () => ({ branch: "main", commit: "abc123" }),
  });
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
    assert.equal(messages.length, 1);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.type, TASK_TIMELINE_ENTRY_TYPE);
    assert.match(messages[0]?.content ?? "", /needs a decision/);
    assert.deepEqual(messages[0]?.options, { triggerTurn: true });

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
    assert.equal(messages.length, 2);
    assert.equal(entries.length, 2);
    assert.equal((await supervisor.get(workstream.id))?.status, "settled");
    assert.equal(
      (entries[0]?.data as { workstreamId?: string }).workstreamId,
      workstream.id,
    );
    assert.equal(TASK_HANDOFF_MESSAGE_TYPE, "pi-tools:subagent-task-handoff");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
