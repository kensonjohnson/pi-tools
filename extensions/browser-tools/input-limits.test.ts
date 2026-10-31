import { test } from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import { createManagedBrowserExtension } from "./registration.ts";
import { resolveBrowserSettings, BROWSER_SETTINGS } from "./settings.ts";

test("tool schemas accept long inputs and actual platform timer bounds", async () => {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function>();
  let active: string[] = [];
  createManagedBrowserExtension(
    {
      events: { emit() {}, on() {} },
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
        ({ shutdown: async () => ({ complete: true }) }) as never,
    },
  );
  const ctx = {
    cwd: "/tmp",
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "owner" },
  };
  await handlers.get("session_start")!({}, ctx);
  const valid = (name: string, args: unknown) =>
    Value.Check(tools.get(name).parameters, args);
  for (const timeoutMs of [30001, 2147483647])
    assert.ok(
      valid("browser_attachment", {
        action: "inspect",
        attachmentId: "id",
        targetId: "target",
        timeoutMs,
      }),
    );
  assert.equal(
    valid("browser_attachment", {
      action: "inspect",
      attachmentId: "id",
      targetId: "target",
      timeoutMs: 2147483648,
    }),
    false,
  );
  for (const timeoutMs of [300001, 2147483647])
    assert.ok(
      valid("browser_download", {
        action: "wait",
        id: "id",
        sessionId: "s",
        timeoutMs,
      }),
    );
  assert.equal(
    valid("browser_download", {
      action: "wait",
      id: "id",
      sessionId: "s",
      timeoutMs: 2147483648,
    }),
    false,
  );
  assert.ok(valid("browser_viewport", { choice: { width: 40000, height: 1 } }));
  assert.equal(
    valid("browser_viewport", {
      choice: { width: Number.MAX_SAFE_INTEGER + 1, height: 1 },
    }),
    false,
  );
  const selector = "#" + "x".repeat(1100);
  assert.ok(
    valid("browser_navigate", {
      url: "https://example.test/" + "a".repeat(9000),
    }),
  );
  assert.ok(valid("browser_snapshot", { selector, frameSelector: selector }));
  assert.ok(
    valid("browser_action", {
      action: "fill",
      target: {
        role: "button",
        name: "x".repeat(501),
        frameSelector: selector,
        scopeSelector: selector,
      },
      value: "x",
      timeoutMs: 30001,
    }),
  );
  assert.ok(
    valid("browser_action", {
      action: "click",
      target: { selector },
      timeoutMs: 2147483647,
    }),
  );
  assert.ok(
    valid("browser_snapshot_ref", {
      ref: "x",
      action: "click",
      timeoutMs: 30001,
    }),
  );
  assert.ok(
    valid("browser_upload", {
      mode: "chooser",
      selector,
      paths: ["file"],
      timeoutMs: 3600001,
    }),
  );
  assert.ok(
    valid("browser_dialog", {
      action: "accept",
      id: "x",
      promptText: "x".repeat(1001),
    }),
  );
  assert.ok(valid("browser_eval", { code: "x".repeat(200001) }));
  assert.equal(
    valid("browser_action", {
      action: "click",
      target: { selector },
      timeoutMs: 2147483648,
    }),
    false,
  );
  assert.equal(
    resolveBrowserSettings({ navigationTimeoutMs: 180001 }).navigationTimeoutMs,
    180001,
  );
  assert.equal(BROWSER_SETTINGS.fields.navigationTimeoutMs.maximum, 2147483647);
  await handlers.get("session_shutdown")!({}, ctx);
});
