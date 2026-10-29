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
    const saved = snapshot(1201);
    MemoryManager.prototype.captureAddPrecondition = async () => saved;
    let calls = 0;
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
        find: () => ({ provider: "p", id: "model", input: ["text"] }),
        getApiKeyAndHeaders: async () => ({ ok: true }),
        complete: async () => ({
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: ++calls % 2 ? '{"paths":[]}' : '{"action":"no_change"}',
            },
          ],
        }),
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
    assert.equal(first.details.result.status, "pending");
    assert.equal(first.details.result.nextOffset, 1200);
    assert.equal(calls, 48);
    await a.handlers.get("session_shutdown")!({}, ctx);
    const b = harness();
    const before = await b.tools
      .get("memory_review")
      .execute("", { action: "status" }, undefined, undefined, ctx);
    assert.equal(before.details.report.status.manualContinuation.offset, 1200);
    await b.commands.get("memory-review").handler("full", ctx);
    for (
      let i = 0;
      i < 100 && !notices.some((x) => /review done/i.test(x));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(notices.some((x) => /review done/i.test(x)));
    assert.equal(calls, 50);
    const after = await b.tools
      .get("memory_review")
      .execute("", { action: "status" }, undefined, undefined, ctx);
    assert.equal(after.details.report.status.manualContinuation, undefined);
    await b.handlers.get("session_shutdown")!({}, ctx);
  } finally {
    MemoryManager.prototype.captureAddPrecondition = original;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
