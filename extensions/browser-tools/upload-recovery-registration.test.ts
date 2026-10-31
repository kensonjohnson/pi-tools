import { test } from "node:test";
import assert from "node:assert/strict";
import { createManagedBrowserExtension } from "./registration.ts";

test("session recovery tool and shutdown warnings request only the current owner's paths", async () => {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  let active: string[] = [];
  const pi = {
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
  };
  const requested: string[] = [];
  const recovery = (owner: string) => {
    requested.push(owner);
    return {
      entries:
        owner === "owner-a"
          ? [{ path: "/private/a", sessionId: "s", status: "closure_unknown" }]
          : [],
      pendingPreparations: 0,
      note: "unknown",
    };
  };
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createSessions: () =>
      ({
        uploadRecovery: recovery,
        shutdown: async (_timeout: number, owner: string) => ({
          complete: false,
          uploadRecovery: recovery(owner),
          downloadRisk:
            owner === "owner-a"
              ? [
                  {
                    sessionId: "s",
                    id: "download-a",
                    state: "failed",
                    nativeRecovery: "available_until_session_close",
                  },
                ]
              : [],
        }),
      }) as never,
  });
  const ctx = {
    cwd: "/tmp",
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "owner-a" },
  };
  await handlers.get("session_start")!({}, ctx);
  const tool = tools.get("browser_session");
  const own = await tool.execute(
    "x",
    { action: "upload_recovery" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(JSON.stringify(own), /\/private\/a/);
  const other = await tool.execute(
    "x",
    { action: "upload_recovery" },
    undefined,
    undefined,
    { ...ctx, sessionManager: { getSessionId: () => "owner-b" } },
  );
  assert.doesNotMatch(JSON.stringify(other), /\/private\/a/);
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (value: unknown) => {
    warnings.push(String(value));
  };
  try {
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    console.warn = original;
  }
  assert.match(warnings.join("\n"), /\/private\/a/);
  assert.match(
    warnings.join("\n"),
    /may have destroyed unexported native downloads/,
  );
  assert.match(warnings.join("\n"), /download-a/);
  assert.deepEqual(requested, ["owner-a", "owner-b", "owner-a"]);
});
