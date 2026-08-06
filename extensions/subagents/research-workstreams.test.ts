import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentLaunchPolicy } from "./launch-policy.ts";
import {
  buildResearchBrief,
  ResearchWorkstreamService,
  RESEARCH_HANDOFF_MESSAGE_TYPE,
  RESEARCH_TIMELINE_ENTRY_TYPE,
} from "./research-workstreams.ts";
import { TaskWorkstreamService } from "./task-workstreams.ts";
import type { WorkerSession } from "./supervisor.ts";
import { WorkstreamSupervisor } from "./supervisor.ts";

class FakeWorkerSession {
  readonly sessionFile: string;
  messages: AgentMessage[] = [];
  prompts: string[] = [];
  followUps: string[] = [];
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
    this.followUps.push(text);
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

function researchReport(): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `<research-job-report>\n{"status":"completed","synthesis":"The evidence supports the selected implementation.","citations":[{"url":"https://example.com/evidence","title":"Evidence source","note":"Direct support."},{"url":"not-a-url","title":"Ignored","note":"Invalid."}],"nextAction":"Apply the cited implementation guidance."}\n</research-job-report>`,
      },
    ],
    timestamp: Date.now(),
  } as AgentMessage;
}

test("retains cited research artifacts, hands off one synthesis, and informs a linked live task worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-research-workstream-"));
  const sessions: FakeWorkerSession[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const messages: Array<{ content: string; options: unknown }> = [];
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
    observeGit: async () => ({ branch: "main", commit: "abc123" }),
  });
  const pi = {
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    sendMessage(message: { content?: unknown }, options: unknown) {
      messages.push({ content: String(message.content), options });
    },
  };
  const tasks = new TaskWorkstreamService(pi as any, supervisor, root);
  const research = new ResearchWorkstreamService(
    pi as any,
    supervisor,
    tasks,
    root,
  );

  try {
    const task = await supervisor.launch({
      kind: "task",
      brief: "# Task-worker brief\nUse research when available.",
      policy,
    });
    await Promise.resolve();
    const brief = buildResearchBrief({
      question: "Which implementation is supported?",
      scope: "Use primary evidence and cite URLs.",
      linkedTaskWorkstreamId: task.id,
    });
    assert.match(brief, /Research-job brief/);
    assert.match(brief, /research-job-report/);
    const job = await supervisor.launch({
      kind: "research",
      brief,
      linkedTaskWorkstreamId: task.id,
      policy,
    });
    await Promise.resolve();
    sessions[1].messages = [researchReport()];
    sessions[1].settle();
    await supervisor.waitForSettlement(job.id);

    const current = await research.currentReport(job.id);
    assert.equal(current.report?.status, "completed");
    assert.equal(current.report?.citations.length, 1);
    assert.match(current.sourceIndexArtifact ?? "", /sources\/0001\.json/);
    assert.equal((await supervisor.get(job.id))?.status, "settled");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.type, RESEARCH_TIMELINE_ENTRY_TYPE);
    assert.equal(messages.length, 1);
    assert.match(
      messages[0]?.content ?? "",
      /Evidence source: https:\/\/example.com\/evidence/,
    );
    assert.deepEqual(messages[0]?.options, { triggerTurn: true });
    assert.equal(
      RESEARCH_HANDOFF_MESSAGE_TYPE,
      "pi-tools:subagent-research-handoff",
    );
    assert.equal(sessions[0].followUps.length, 1);
    assert.match(sessions[0].followUps[0] ?? "", /Linked research synthesis/);
    assert.doesNotMatch(sessions[0].followUps[0] ?? "", /research-job-report/);
    const sourceIndex = JSON.parse(
      await readFile(join(root, current.sourceIndexArtifact ?? ""), "utf8"),
    ) as { citations: Array<{ url: string }> };
    assert.deepEqual(
      sourceIndex.citations.map((citation) => citation.url),
      ["https://example.com/evidence"],
    );
    const journal = await readFile(
      join(root, "subagents", job.id, "journal.md"),
      "utf8",
    );
    assert.match(journal, /delivered: Cited synthesis delivered/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
