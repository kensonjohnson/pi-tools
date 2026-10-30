import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import extension from "./index.ts";

function snapshot(count: number) {
  const contents = Array.from(
    { length: count },
    (_, i) =>
      JSON.stringify({ id: `id-${i}`, content: `Fact ${i}`, created: "2025" }) +
      "\n",
  ).join("");
  return {
    snapshots: {
      knowledge: { contents, mode: 0o600 },
      practices: { contents: "", mode: 0o600 },
      decisions: { contents: "", mode: 0o600 },
    },
  };
}

test("guessed valid snapshot cannot skip pages on a fresh reviewer", async () => {
  const saved = snapshot(60);
  const hash = createHash("sha256")
    .update(JSON.stringify(saved.snapshots))
    .digest("hex");
  let calls = 0;
  const reviewer = new MemoryReviewer({
    project: "/project",
    store: { captureAddPrecondition: async () => saved } as any,
    model: {
      generate: async () => {
        calls++;
        return {};
      },
    },
  });
  await assert.rejects(
    reviewer.review({ fullOffset: 60, fullSnapshot: hash }),
    /reviewed in order/,
  );
  assert.throws(
    () =>
      new MemoryReviewer({
        project: "/project",
        store: {} as any,
        model: {} as any,
        fullContinuation: { offset: 60, snapshot: hash } as any,
      }),
    /invalid manual review continuation permit/,
  );
  assert.equal(calls, 0);
});

test("bounded manual continuation survives reload and /memory-review full continues it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-continuation-")),
    agent = await mkdtemp(join(tmpdir(), "review-agent-"));
  const oldAgent = process.env.PI_CODING_AGENT_DIR,
    original = MemoryManager.prototype.captureAddPrecondition;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    await mkdir(join(cwd, ".pi", "memory"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "pi-tools.json"),
      JSON.stringify({
        version: 1,
        extensions: {
          memory: {
            historyReview: { enabled: false },
            models: { reviewer: "p/model" },
          },
        },
      }),
    );
    await writeFile(join(cwd, "evidence.txt"), "Fixture evidence.\n");
    const saved = snapshot(1201);
    MemoryManager.prototype.captureAddPrecondition = async () => saved;
    let calls = 0,
      decisions = 0;
    const notices: string[] = [];
    const ctx: any = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      sessionManager: { getSessionDir: () => cwd },
      ui: {
        setStatus() {},
        notify(text: string) {
          notices.push(text);
        },
      },
      modelRegistry: {
        getAvailable: () => [],
        find: () => ({
          provider: "p",
          id: "model",
          input: ["text"],
          contextWindow: 1600,
        }),
        getApiKeyAndHeaders: async () => ({ ok: true }),
        complete: async (_model: unknown, request: any) => {
          calls++;
          const selecting = request.systemPrompt.includes(
            "Select evidence requests",
          );
          const text = selecting
            ? decisions === 0
              ? '{"paths":[]}'
              : '{"paths":["evidence.txt"]}'
            : ++decisions === 1
              ? '{"action":"no_change","reason":"Evidence missing","evidenceSufficient":false}'
              : '{"action":"no_change","reason":"Fixture review","evidenceSufficient":true}';
          return { stopReason: "stop", content: [{ type: "text", text }] };
        },
      },
    };
    const harness = () => {
      const handlers = new Map<string, Function>(),
        commands = new Map<string, any>(),
        tools = new Map<string, any>();
      const pi: any = {
        events: {
          on() {
            return () => {};
          },
          emit() {},
        },
        on(n: string, f: Function) {
          handlers.set(n, f);
        },
        registerCommand(n: string, d: any) {
          commands.set(n, d);
        },
        registerTool(t: any) {
          tools.set(t.name, t);
        },
        getActiveTools() {
          return [];
        },
        setActiveTools() {},
      };
      extension(pi);
      return { handlers, commands, tools };
    };
    const a = harness();
    const first = await a.tools
      .get("memory_review")
      .execute("", { action: "full" }, undefined, undefined, ctx);
    assert.equal(
      first.details.result.status,
      "pending",
      JSON.stringify(first.details.result),
    );
    const resumeOffset = first.details.result.nextOffset;
    assert.ok(resumeOffset > 0 && resumeOffset < 1201);
    assert.deepEqual(first.details.result.review, {
      pages: 24,
      resumedAtOffset: 0,
      evidenceGaps: 1,
      gapReasons: { model_insufficient: 1, no_evidence: 1 },
      limitedPages: 23,
      discoveryTruncatedPages: 0,
      searchIncompletePages: 0,
      candidatesTruncatedPages: 0,
      memoryEvaluations: resumeOffset,
      snapshotMemories: 1201,
    });
    assert.match(first.content[0].text, /Coverage is not verification/);
    assert.equal(decisions, 24);
    const initialCalls = calls;
    await a.handlers.get("session_shutdown")!({}, ctx);
    const b = harness();
    const before = await b.tools
      .get("memory_review")
      .execute("", { action: "status" }, undefined, undefined, ctx);
    assert.equal(
      before.details.report.status.manualContinuation.offset,
      resumeOffset,
    );
    await b.commands.get("memory-review").handler("full", ctx);
    for (
      let i = 0;
      i < 100 && !notices.some((x) => /review unresolved/i.test(x));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      notices.some((x) => /review unresolved/i.test(x)),
      JSON.stringify(notices),
    );
    assert.ok(calls > initialCalls);
    const after = await b.tools
      .get("memory_review")
      .execute("", { action: "status" }, undefined, undefined, ctx);
    assert.equal(after.details.report.status.manualContinuation, undefined);
    assert.match(
      after.details.report.eventScope,
      /one run, not the cumulative review/,
    );
    assert.deepEqual(
      after.details.report.events.slice(0, 2).map((event: any) => event.review),
      [
        {
          pages: decisions - 24,
          resumedAtOffset: resumeOffset,
          evidenceGaps: 0,
          limitedPages: decisions - 24,
          discoveryTruncatedPages: 0,
          searchIncompletePages: 0,
          candidatesTruncatedPages: 0,
          memoryEvaluations: 1201 - resumeOffset,
          snapshotMemories: 1201,
        },
        {
          pages: 24,
          resumedAtOffset: 0,
          evidenceGaps: 1,
          gapReasons: { model_insufficient: 1, no_evidence: 1 },
          limitedPages: 23,
          discoveryTruncatedPages: 0,
          searchIncompletePages: 0,
          candidatesTruncatedPages: 0,
          memoryEvaluations: resumeOffset,
          snapshotMemories: 1201,
        },
      ],
    );
    assert.match(
      after.details.report.events[0].detail,
      /insufficient or unknown evidence/i,
    );
    await b.handlers.get("session_shutdown")!({}, ctx);
  } finally {
    MemoryManager.prototype.captureAddPrecondition = original;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
