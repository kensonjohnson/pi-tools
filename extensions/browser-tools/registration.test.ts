import { test } from "node:test";
import assert from "node:assert/strict";
import { createManagedBrowserExtension } from "./registration.ts";

test("staged registration keeps untrusted defaults active but denies installation and invalidates on shutdown", async () => {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  let active = ["read"];
  const definitions: unknown[] = [];
  let definitionRequest: (() => void) | undefined;
  const pi = {
    events: {
      emit: (_name: string, value: unknown) => definitions.push(value),
      on: (_name: string, handler: () => void) => {
        definitionRequest = handler;
        return () => {};
      },
    },
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
      active.push(tool.name);
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
  };
  let trust: boolean | undefined;
  let shutdown = 0;
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createInstaller: () =>
      ({
        ensure: async (options: any) => {
          trust = options.trusted;
          return { ok: false, message: "Missing binary" };
        },
      }) as never,
    createSessions: () =>
      ({
        shutdown: async () => {
          shutdown++;
          return { complete: true };
        },
      }) as never,
  });
  definitionRequest?.();
  assert.ok(definitions.length);
  assert.equal(tools.size, 0);
  await handlers.get("session_start")!(
    {},
    { cwd: "/tmp", isProjectTrusted: () => false },
  );
  assert.ok(active.includes("browser_session"));
  assert.ok(!active.includes("browser_start"));
  await assert.rejects(
    tools
      .get("browser_session")
      .execute("x", { action: "start" }, undefined, undefined),
    /Missing binary/,
  );
  assert.equal(trust, false);
  await handlers.get("session_shutdown")!({}, {});
  assert.equal(shutdown, 1);
  assert.deepEqual(active, ["read"]);
  await assert.rejects(
    tools.get("browser_session").execute("x", { action: "list" }),
    /disabled or unavailable/,
  );
});

test("disabled startup leaves foreign names untouched and later lifecycle registers only once", async () => {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  let active = ["read", "browser_navigate"];
  let enabled = false,
    registrations = 0,
    shutdown = 0;
  const pi = {
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerTool: (tool: any) => {
      registrations++;
      tools.set(tool.name, tool);
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
  };
  const ctx = { cwd: "/tmp", isProjectTrusted: () => true };
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () =>
      ({ values: { "browser-tools": { enabled } } }) as never,
    createSessions: () =>
      ({
        shutdown: async () => {
          shutdown++;
          return { complete: true };
        },
      }) as never,
  });
  await handlers.get("session_start")!({}, ctx);
  assert.deepEqual(active, ["read", "browser_navigate"]);
  assert.equal(registrations, 0);
  await handlers.get("session_shutdown")!({}, ctx);
  assert.deepEqual(active, ["read", "browser_navigate"]);
  active = ["read"];
  enabled = true;
  await handlers.get("session_start")!({}, ctx);
  const count = registrations;
  assert.ok(count > 1);
  assert.ok(active.includes("browser_navigate"));
  await handlers.get("session_shutdown")!({}, ctx);
  assert.deepEqual(active, ["read"]);
  await handlers.get("session_start")!({}, ctx);
  assert.equal(registrations, count);
  assert.ok(active.includes("browser_session"));
  enabled = false;
  await handlers.get("session_start")!({}, ctx);
  assert.deepEqual(active, ["read"]);
  assert.equal(shutdown, 2);
});
