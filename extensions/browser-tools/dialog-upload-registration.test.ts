import { test } from "node:test";
import assert from "node:assert/strict";
import { createManagedBrowserExtension } from "./registration.ts";

test("staged upload and dialog tools forward owner, cwd, limits and exact dialog ID", async () => {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  let active: string[] = [];
  let upload: any[], dialog: any[];
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
    loadSettings: async () =>
      ({
        values: {
          "browser-tools": {
            uploadMaxFileBytes: 1234,
            uploadMaxTotalBytes: 5678,
          },
        },
      }) as never,
    createSessions: () =>
      ({
        upload: async (...args: any[]) => {
          upload = args;
          return { status: "completed" };
        },
        dialog: async (...args: any[]) => {
          dialog = args;
          return { status: "resolved" };
        },
        shutdown: async () => ({ complete: true }),
      }) as never,
  });
  const ctx = {
    cwd: "/tmp/explicit-cwd",
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "owner" },
  };
  await handlers.get("session_start")!({}, ctx);
  assert.ok(
    active.includes("browser_upload") && active.includes("browser_dialog"),
  );
  await tools
    .get("browser_upload")
    .execute(
      "id",
      { ref: "ref", paths: ["file"], mode: "chooser" },
      undefined,
      undefined,
      ctx,
    );
  assert.equal(upload![1], "owner");
  assert.deepEqual(
    {
      cwd: upload![2].cwd,
      maxFileBytes: upload![2].maxFileBytes,
      maxTotalBytes: upload![2].maxTotalBytes,
      mode: upload![2].mode,
    },
    { cwd: ctx.cwd, maxFileBytes: 1234, maxTotalBytes: 5678, mode: "chooser" },
  );
  await tools
    .get("browser_dialog")
    .execute(
      "id",
      { action: "dismiss", id: "dialog" },
      undefined,
      undefined,
      ctx,
    );
  assert.equal(dialog![1], "owner");
  assert.equal(dialog![2].id, "dialog");
  await handlers.get("session_shutdown")!({}, ctx);
  assert.ok(
    !active.includes("browser_upload") && !active.includes("browser_dialog"),
  );
});
