import { test } from "node:test";
import assert from "node:assert/strict";
import { createManagedBrowserExtension } from "./registration.ts";

test("upload registration forwards strict chooser target and MIME overrides", async () => {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  let active: string[] = [],
    received: any[] = [];
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
        upload: async (...args: any[]) => {
          received = args;
          return { status: "completed" };
        },
        shutdown: async () => ({ complete: true }),
      }) as never,
  });
  const ctx = {
    cwd: "/tmp/example",
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "owner" },
  };
  await handlers.get("session_start")!({}, ctx);
  await tools.get("browser_upload").execute(
    "id",
    {
      mode: "chooser",
      selector: "label",
      frameSelector: "iframe",
      scopeSelector: "section",
      paths: ["x"],
      mimeTypes: ["image/png"],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(received[1], "owner");
  assert.equal(received[2].selector, "label");
  assert.equal(received[2].frameSelector, "iframe");
  assert.equal(received[2].scopeSelector, "section");
  assert.deepEqual(received[2].mimeTypes, ["image/png"]);
  assert.match(
    tools.get("browser_upload").description,
    /parent-directory symlinks are followed/,
  );
  await handlers.get("session_shutdown")!({}, ctx);
});
