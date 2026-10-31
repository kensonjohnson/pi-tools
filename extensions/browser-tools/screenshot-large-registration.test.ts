import { test } from "node:test";
import assert from "node:assert/strict";
import { createManagedBrowserExtension } from "./registration.ts";

test("screenshot registration preserves explicit artifact-only image omission", async () => {
  const handlers = new Map<string, Function>(),
    tools = new Map<string, any>();
  let active: string[] = [];
  const metadata = {
    artifact: { id: "artifact" },
    imageOmitted: true,
    imageOmissionReason: "platform string limit",
  };
  createManagedBrowserExtension(
    {
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
    } as never,
    {
      loadSettings: async () => ({ values: {} }) as never,
      createSessions: () =>
        ({
          screenshot: async () => ({
            target: { sessionId: "s", tabId: "t" },
            content: [{ type: "text", text: JSON.stringify(metadata) }],
          }),
          shutdown: async () => ({ complete: true }),
        }) as never,
    },
  );
  const ctx = {
    cwd: "/tmp",
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "owner" },
  };
  try {
    await handlers.get("session_start")!({}, ctx);
    const result = await tools
      .get("browser_screenshot")
      .execute("id", {}, undefined, undefined, ctx);
    assert.equal(result.content.length, 1);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      target: { sessionId: "s", tabId: "t" },
      ...metadata,
    });
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
  }
});
