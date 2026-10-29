import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ManagedSessions } from "./sessions.ts";
import { createManagedBrowserExtension } from "./registration.ts";

function harness(config: Record<string, unknown> = {}) {
  const tools = new Map<string, any>(),
    handlers = new Map<string, Function>();
  let active: string[] = [];
  const pi = {
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    on(name: string, f: Function) {
      handlers.set(name, f);
    },
    registerTool(t: any) {
      tools.set(t.name, t);
      active.push(t.name);
    },
    getActiveTools: () => active,
    setActiveTools(v: string[]) {
      active = v;
    },
  };
  const pages: any[] = [];
  const browser = new EventEmitter() as any;
  browser.newContext = async () => ({
    newPage: async () => {
      const page = new EventEmitter() as any;
      page.closed = false;
      page.isClosed = () => page.closed;
      page.url = () => "about:blank";
      page.goto = async () => {
        page.emit("console", {
          type: () => "log",
          text: () => "navigation event",
          location: () => ({}),
        });
        if (page.wait) await page.wait;
      };
      page.close = async () => {
        page.closed = true;
        page.emit("close");
      };
      pages.push(page);
      return page;
    },
  });
  browser.close = async () => {
    for (const p of pages) await p.close();
    browser.emit("disconnected");
  };
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () =>
      ({ values: { "browser-tools": config } }) as never,
    createInstaller: () => ({ ensure: async () => ({ ok: true }) }) as never,
    createSessions: (diagnostics) =>
      new ManagedSessions({ launch: async () => browser, diagnostics }),
  });
  const call = async (name: string, args: any, signal?: AbortSignal) =>
    JSON.parse(
      (await tools.get(name).execute("id", args, signal)).content[0].text,
    );
  const start = () =>
    handlers.get("session_start")!(
      {},
      { cwd: "/tmp", isProjectTrusted: () => true },
    );
  const shutdown = () => handlers.get("session_shutdown")!();
  return { call, start, shutdown, pages, active: () => active, tools };
}

test("staged tools capture before navigation and discard on tab/session close and cancellation", async () => {
  const h = harness();
  await h.start();
  const first = await h.call("browser_session", { action: "start" });
  await h.call("browser_navigate", { ...first, url: "https://example.test/" });
  assert.equal(
    (await h.call("browser_diagnostics", { ...first, action: "read" })).logs[0]
      .text,
    "navigation event",
  );
  const second = await h.call("browser_session", {
    action: "new_tab",
    sessionId: first.sessionId,
  });
  await h.call("browser_navigate", { ...second, url: "https://example.test/" });
  assert.equal(
    (await h.call("browser_diagnostics", { ...second, action: "read" })).logs
      .length,
    1,
  );
  await assert.rejects(
    h.call("browser_diagnostics", {
      sessionId: first.sessionId,
      tabId: "unowned",
      action: "read",
    }),
    /unavailable/,
  );
  await h.call("browser_session", { ...second, action: "close_tab" });
  await assert.rejects(
    h.call("browser_diagnostics", { ...second, action: "read" }),
    /unavailable/,
  );
  let release!: () => void;
  h.pages[0].wait = new Promise<void>((r) => (release = r));
  const abort = new AbortController();
  const navigation = h.call(
    "browser_navigate",
    { ...first, url: "https://example.test/" },
    abort.signal,
  );
  abort.abort();
  await assert.rejects(navigation, /cancelled/);
  await assert.rejects(
    h.call("browser_diagnostics", { ...first, action: "read" }),
    /unavailable/,
  );
  release();
  await h.shutdown();
  assert(!h.active().includes("browser_diagnostics"));
  await assert.rejects(
    h.call("browser_diagnostics", { ...first, action: "read" }),
    /disabled or unavailable/,
  );
});

test("shutdown invalidates diagnostics before an in-flight navigation settles", async () => {
  const h = harness();
  await h.start();
  const target = await h.call("browser_session", { action: "start" });
  let release!: () => void;
  h.pages[0].wait = new Promise<void>((r) => (release = r));
  const navigation = h.call("browser_navigate", {
    ...target,
    url: "https://example.test/",
  });
  const closing = h.shutdown();
  await assert.rejects(
    h.call("browser_diagnostics", { ...target, action: "read" }),
    /disabled or unavailable/,
  );
  await assert.rejects(navigation, /cancelled|closed/);
  release();
  await closing;
  assert.equal(h.pages[0].listenerCount("console"), 0);
});

test("disabled diagnostics never activates tools or subscribes pages", async () => {
  const h = harness({ diagnosticsEnabled: false });
  await h.start();
  assert(!h.active().includes("browser_diagnostics"));
  const target = await h.call("browser_session", { action: "start" });
  assert.equal(h.pages[0].listenerCount("console"), 0);
  await assert.rejects(
    h.call("browser_diagnostics", { ...target, action: "read" }),
    /disabled/,
  );
  await h.shutdown();
});
