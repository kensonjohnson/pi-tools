import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "./index.ts";

test("configured reviewer scans both the explicit session parent and configured directory without blocking the hook", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "scheduler-live-"));
  const agent = await mkdtemp(join(tmpdir(), "scheduler-agent-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    const dir = join(cwd, "external-sessions"),
      configured = join(cwd, "configured-sessions"),
      path = join(dir, "one.jsonl"),
      configuredPath = join(configured, "two.jsonl");
    await mkdir(dir);
    await mkdir(configured);
    await mkdir(join(cwd, ".pi", "memory"), { recursive: true });
    await writeFile(
      path,
      [
        { type: "session", version: 3, id: "s", cwd },
        {
          type: "message",
          id: "a",
          parentId: null,
          message: { role: "user", content: "hello" },
        },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n",
    );
    await writeFile(
      configuredPath,
      [
        { type: "session", version: 3, id: "other", cwd },
        {
          type: "message",
          id: "b",
          parentId: null,
          message: { role: "user", content: "second" },
        },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n",
    );
    await writeFile(
      join(cwd, ".pi", "pi-tools.json"),
      JSON.stringify({
        version: 1,
        extensions: {
          memory: {
            historyReview: {
              debounceSeconds: 0,
              cooldownSeconds: 0,
            },
            models: { reviewer: "test/model" },
          },
        },
      }),
    );
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx: any = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionDir: () => configured,
        getSessionFile: () => path,
      },
      modelRegistry: {
        find: () => ({ provider: "test", id: "model", input: ["text"] }),
        getAvailable: () => [],
        getApiKeyAndHeaders: async () => ({ ok: true }),
        complete: async (_model: unknown, request: any) => {
          calls++;
          if (calls === 1) await gate;
          return {
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: request.systemPrompt.includes("Select evidence requests")
                  ? '{"paths":[]}'
                  : '{"action":"no_change","evidenceSufficient":true,"reason":"Session reviewed."}',
              },
            ],
          };
        },
      },
    };
    const handlers = new Map<string, Function>();
    const pi: any = {
      events: {
        on() {
          return () => {};
        },
        emit() {},
      },
      on(name: string, cb: Function) {
        handlers.set(name, cb);
      },
      registerTool() {},
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
    };
    extension(pi);
    await handlers.get("session_start")!({}, ctx);
    assert.equal(handlers.get("agent_settled")!({}, ctx), undefined);
    for (let i = 0; i < 100 && !calls; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    release();
    const progress = join(
      cwd,
      ".pi",
      "memory",
      ".runtime",
      "review-scheduler",
      "session-progress.json",
    );
    let found = false;
    for (let i = 0; i < 300 && !found; i++) {
      try {
        const state = JSON.parse(await readFile(progress, "utf8"));
        found = !!state.sessions[path] && !!state.sessions[configuredPath];
      } catch {}
      if (!found) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(found, true);
    assert.equal(calls, 6);
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
