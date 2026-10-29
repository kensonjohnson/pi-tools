import { test } from "node:test";
import assert from "node:assert/strict";
import { createManagedBrowserExtension } from "./registration.ts";

test("staged extraction registration carries owner and signal, activates and shuts down", async () => {
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
    on(name: string, handler: Function) {
      handlers.set(name, handler);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
      active.push(tool.name);
    },
    getActiveTools: () => active,
    setActiveTools(value: string[]) {
      active = value;
    },
  };
  let observedOwner: string | undefined;
  let observedSignal: AbortSignal | undefined;
  const fakePage = {
    context: () => ({
      newCDPSession: async () => ({
        send: async (name: string) => {
          if (name === "Page.getFrameTree")
            return { frameTree: { frame: { id: "frame" } } };
          if (name === "Page.createIsolatedWorld")
            return { executionContextId: 1 };
          if (name === "Runtime.evaluate")
            return {
              result: {
                value: {
                  items: [{ kind: "text", value: "safe" }],
                  title: null,
                  url: "https://example.test/",
                  base: "https://example.test/",
                  retrievedAt: 1234567890000,
                },
              },
            };
          throw new Error(name);
        },
        detach: async () => {},
      }),
    }),
  };
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createInstaller: () => ({}) as never,
    createArtifacts: () => ({}) as never,
    createSessions: () =>
      ({
        withOwnedPage: async (
          target: any,
          signal: AbortSignal,
          owner: string,
          work: Function,
        ) => {
          observedOwner = owner;
          observedSignal = signal;
          assert.deepEqual(target, { sessionId: "s", tabId: "t" });
          if (signal.aborted) throw new Error("cancelled");
          return work(fakePage, target);
        },
        shutdown: async () => ({ complete: true }),
      }) as never,
  });
  const ctx = (id: string) => ({
    cwd: "/tmp",
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => id },
  });
  await handlers.get("session_start")!({}, ctx("creator"));
  assert(active.includes("browser_extract"));
  const result = await tools
    .get("browser_extract")
    .execute(
      "id",
      { sessionId: "s", tabId: "t" },
      undefined,
      undefined,
      ctx("caller"),
    );
  assert.equal(observedOwner, "caller");
  assert.equal(observedSignal?.aborted, false);
  const output = JSON.parse(result.content[0].text);
  const record = JSON.parse(output.text);
  assert.equal(record.requestedUrl, null);
  assert.equal(record.text, "safe");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    tools
      .get("browser_extract")
      .execute(
        "id",
        { sessionId: "s", tabId: "t" },
        controller.signal,
        undefined,
        ctx("caller"),
      ),
    /cancelled/,
  );
  await handlers.get("session_shutdown")!();
  assert(!active.includes("browser_extract"));
  await assert.rejects(
    tools
      .get("browser_extract")
      .execute("id", {}, undefined, undefined, ctx("caller")),
    /disabled or unavailable/,
  );
});
