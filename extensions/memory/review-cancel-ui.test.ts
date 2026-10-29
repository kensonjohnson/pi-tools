import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "./index.ts";

test("local cancellation reports in-flight work may continue until it settles", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-cancel-")),
    agent = await mkdtemp(join(tmpdir(), "review-agent-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
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
    const tools = new Map<string, any>(),
      handlers = new Map<string, Function>();
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
      registerTool(t: any) {
        tools.set(t.name, t);
      },
    };
    extension(pi);
    let called = false;
    const ctx: any = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: { getSessionDir: () => cwd },
      modelRegistry: {
        getAvailable: () => [],
        find: () => ({ input: ["text"], provider: "p", id: "model" }),
        getApiKeyAndHeaders: async () => ({ ok: true }),
        complete: async () => {
          called = true;
          await gate;
          return {
            stopReason: "stop",
            content: [{ type: "text", text: '{"paths":[]}' }],
          };
        },
      },
    };
    const tool = tools.get("memory_review");
    const running = tool.execute(
      "",
      { action: "full" },
      undefined,
      undefined,
      ctx,
    );
    for (let i = 0; i < 100 && !called; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(called, true);
    const cancel = await tool.execute(
      "",
      { action: "cancel" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(cancel.details.mayContinue, true);
    assert.match(cancel.content[0].text, /may still finish/);
    release();
    const outcome = await running;
    assert.equal(outcome.details.result.status, "uncertain");
    const report = await tool.execute(
      "",
      { action: "status" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(report.details.report.status.paused, true);
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    release();
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
