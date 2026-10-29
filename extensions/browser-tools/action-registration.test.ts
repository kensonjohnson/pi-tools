import { test } from "node:test";
import assert from "node:assert/strict";
import { createManagedBrowserExtension } from "./registration.ts";

test("staged action tool forwards owner, target and cancellation and is removed on shutdown", async () => {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  let active: string[] = [];
  let received: any;
  const pi = {
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    on: (n: string, f: Function) => handlers.set(n, f),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getActiveTools: () => active,
    setActiveTools: (v: string[]) => {
      active = v;
    },
  };
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createSessions: () =>
      ({
        action: async (...args: any[]) => {
          received = args;
          return { status: "completed", verification: "no_expectation" };
        },
        shutdown: async () => ({ complete: true }),
      }) as never,
  });
  const ctx = {
    cwd: "/tmp",
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "owner" },
  };
  await handlers.get("session_start")!({}, ctx);
  assert.ok(active.includes("browser_action"));
  const abort = new AbortController();
  const input = {
    action: "click",
    target: { selector: "#button" },
    sessionId: "session",
    tabId: "tab",
  };
  const result = await tools
    .get("browser_action")
    .execute("id", input, abort.signal, undefined, ctx);
  assert.equal(received[1], "owner");
  assert.equal(received[2], input);
  assert.equal(received[3].aborted, false);
  abort.abort();
  assert.equal(received[3].aborted, true);
  assert.match(result.content[0].text, /no_expectation/);
  await handlers.get("session_shutdown")!({}, ctx);
  assert.ok(!active.includes("browser_action"));
});
