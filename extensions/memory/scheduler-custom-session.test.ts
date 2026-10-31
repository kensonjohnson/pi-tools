import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";

test("custom session startup does not create or dispatch background review", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "scheduler-custom-"));
  const agent = await mkdtemp(join(tmpdir(), "scheduler-agent-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    const customDir = join(cwd, "external");
    const defaultDir = join(cwd, "standard");
    const sessionPath = join(customDir, "custom.session");
    await mkdir(customDir);
    await mkdir(defaultDir);
    await mkdir(join(cwd, ".pi", "memory"), { recursive: true });
    await writeFile(
      sessionPath,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "custom",
        timestamp: new Date().toISOString(),
        cwd,
      }) + "\n",
    );
    await writeFile(
      join(cwd, ".pi", "pi-tools.json"),
      JSON.stringify({
        version: 1,
        extensions: {
          memory: {
            historyReview: {
              enabled: true,
              debounceSeconds: 0,
              cooldownSeconds: 0,
            },
            models: { reviewer: "test/model" },
          },
        },
      }),
    );
    let providerCalls = 0;
    const ctx: any = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: SessionManager.open(sessionPath, defaultDir, cwd),
      modelRegistry: {
        find() {
          providerCalls++;
        },
        getAvailable() {
          return [];
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
    await handlers.get("agent_settled")!({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await handlers.get("session_shutdown")!({}, ctx);
    assert.equal(providerCalls, 0);
    await assert.rejects(
      access(join(cwd, ".pi", "memory", ".runtime", "review-scheduler")),
      { code: "ENOENT" },
    );
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
