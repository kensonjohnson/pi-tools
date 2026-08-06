import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PROACTIVE_DELEGATION_GUIDANCE,
  isSubagentWorkerSession,
} from "./index.ts";
import { SUBAGENT_TOOL_NAMES } from "./settings.ts";

function makePi() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  let active = ["read", ...SUBAGENT_TOOL_NAMES];
  return {
    handlers,
    pi: {
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      on(name: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(name, handler);
      },
      registerTool() {},
      registerEntryRenderer() {},
      getActiveTools: () => active,
      setActiveTools(toolNames: string[]) {
        active = toolNames;
      },
    },
    activeTools: () => active,
  };
}

function mainContext(cwd: string) {
  return {
    cwd,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionDir: () => join(cwd, ".pi", "agent", "sessions"),
    },
    ui: { setWidget() {} },
  };
}

test("injects proactive delegation guidance only for an enabled trusted main session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-proactive-delegation-"));
  const { default: extension } = await import("./index.ts");
  const { pi, handlers } = makePi();
  const ctx = mainContext(root);
  try {
    extension(pi as unknown as ExtensionAPI);
    await handlers.get("session_start")?.({}, ctx);
    const result = await handlers.get("before_agent_start")?.(
      { systemPrompt: "Base prompt" },
      ctx,
    );
    assert.match(
      (result as { systemPrompt?: string })?.systemPrompt ?? "",
      /Proactive subagent delegation/,
    );
    assert.match(PROACTIVE_DELEGATION_GUIDANCE, /Do not wait for the user/);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes SDK worker sessions and prevents recursive subagent activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-proactive-worker-"));
  const { default: extension } = await import("./index.ts");
  const { pi, handlers, activeTools } = makePi();
  const ctx = {
    ...mainContext(root),
    sessionManager: {
      getSessionDir: () =>
        join(root, "tmp", "subagents", "worker-id", "session"),
    },
  };
  try {
    assert.equal(isSubagentWorkerSession(ctx), true);
    extension(pi as unknown as ExtensionAPI);
    await handlers.get("session_start")?.({}, ctx);
    assert.deepEqual(activeTools(), ["read"]);
    assert.equal(
      await handlers.get("before_agent_start")?.(
        { systemPrompt: "Base prompt" },
        ctx,
      ),
      undefined,
    );
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    await rm(root, { recursive: true, force: true });
  }
});
