import { test } from "node:test";
import assert from "node:assert/strict";
import { createManagedBrowserExtension } from "./registration.ts";

test("staged attachment requires trust and explicit selection arguments", async () => {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  let active: string[] = [],
    called = 0;
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
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createSessions: () =>
      ({
        attachExternal: async () => {
          called++;
        },
        listAttachments: () => [],
        shutdown: async () => ({ complete: true }),
      }) as never,
  });
  const ctx = {
    cwd: "/tmp",
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "owner" },
  };
  await handlers.get("session_start")!({}, ctx);
  assert.ok(active.includes("browser_attachment"));
  await assert.rejects(
    tools
      .get("browser_attachment")
      .execute(
        "id",
        { action: "connect", endpoint: "http://127.0.0.1:1" },
        undefined,
        undefined,
        ctx,
      ),
    /trusted project/,
  );
  assert.equal(called, 0);
  await assert.rejects(
    tools
      .get("browser_attachment")
      .execute(
        "id",
        { action: "select", attachmentId: "id" },
        undefined,
        undefined,
        ctx,
      ),
    /targetId is required/,
  );
  await handlers.get("session_shutdown")!({}, ctx);
  assert.ok(!active.includes("browser_attachment"));
});
