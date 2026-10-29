import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { ManagedSessions } from "./sessions.ts";
import { DownloadManager, type NativeDownload } from "./downloads.ts";
import { createManagedBrowserExtension } from "./registration.ts";

function browser() {
  const browser = new EventEmitter() as any;
  const pages: any[] = [];
  browser.newContext = async () => ({
    newPage: async () => {
      const page = new EventEmitter() as any;
      let closed = false;
      page.isClosed = () => closed;
      page.url = () => "https://example.test/private";
      page.goto = async () => {};
      page.content = async () => "private-content";
      page.evaluate = async () => ({
        text: "private-eval",
        representation: "string",
      });
      page.close = async () => {
        closed = true;
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
  return browser;
}

test("two Pi owners cannot inspect, mutate, or select each other's browser session", async () => {
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
    on(n: string, f: Function) {
      handlers.set(n, f);
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
  const context = (id: string) => ({
    cwd: "/tmp",
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => id },
  });
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createInstaller: () => ({ ensure: async () => ({ ok: true }) }) as never,
    createSessions: (diagnostics, downloads) =>
      new ManagedSessions({
        launch: async () => browser(),
        diagnostics,
        downloads,
      }),
  });
  const call = async (name: string, args: any, owner: string) =>
    JSON.parse(
      (
        await tools
          .get(name)
          .execute("id", args, undefined, undefined, context(owner))
      ).content[0].text,
    );
  await handlers.get("session_start")!({}, context("alice"));
  try {
    const alice = await call("browser_session", { action: "start" }, "alice");
    assert.deepEqual(
      (await call("browser_session", { action: "list" }, "bob")).sessions,
      [],
    );
    const attempts: [string, any][] = [
      ["browser_session", { action: "select", ...alice }],
      ["browser_session", { action: "new_tab", sessionId: alice.sessionId }],
      ["browser_session", { action: "close_tab", ...alice }],
      ["browser_session", { action: "stop", sessionId: alice.sessionId }],
      ["browser_navigate", { ...alice, url: "https://example.test" }],
      ["browser_content", alice],
      ["browser_eval", { ...alice, code: "1" }],
      ["browser_diagnostics", { ...alice, action: "read" }],
      ["browser_diagnostics", { ...alice, action: "clear" }],
      [
        "browser_diagnostic_body",
        { ...alice, action: "configure", enabled: true },
      ],
      [
        "browser_diagnostic_body",
        { ...alice, action: "inspect", requestId: "r", direction: "request" },
      ],
      [
        "browser_diagnostic_body",
        { ...alice, action: "artifact", requestId: "r", direction: "request" },
      ],
      [
        "browser_diagnostic_headers",
        { ...alice, requestId: "r", direction: "request", names: ["cookie"] },
      ],
      ["browser_download", { sessionId: alice.sessionId, action: "list" }],
    ];
    for (const [name, args] of attempts)
      await assert.rejects(
        call(name, args, "bob"),
        /unavailable|owned by another/,
      );
    await assert.rejects(call("browser_content", {}, "bob"), /unavailable/);
    const bob = await call("browser_session", { action: "start" }, "bob");
    assert.equal(
      (await call("browser_content", {}, "alice")).target.sessionId,
      alice.sessionId,
    );
    assert.equal(
      (await call("browser_content", {}, "bob")).target.sessionId,
      bob.sessionId,
    );
    assert.deepEqual(
      (await call("browser_session", { action: "list" }, "alice")).sessions.map(
        (s: any) => s.sessionId,
      ),
      [alice.sessionId],
    );
    assert.deepEqual(
      (await call("browser_session", { action: "list" }, "bob")).sessions.map(
        (s: any) => s.sessionId,
      ),
      [bob.sessionId],
    );
    await call(
      "browser_session",
      { action: "stop", sessionId: bob.sessionId },
      "bob",
    );
    assert.equal(
      (await call("browser_content", {}, "alice")).text,
      "private-content",
    );
  } finally {
    await handlers.get("session_shutdown")!();
  }
});

function native(block = false): NativeDownload {
  return {
    url: () => "https://example.test",
    suggestedFilename: () => "a",
    failure: () => (block ? new Promise(() => {}) : Promise.resolve(null)),
    createReadStream: async () => Readable.from([Buffer.from("a")]),
    cancel: async () => {},
    delete: async () => {},
  };
}
test("rejected or admitted work cannot evict another owner's records", async () => {
  const manager = new DownloadManager({
    sink: {
      async putBinary(_owner, data) {
        for await (const _ of data) {
        }
        return { id: "artifact", path: "/private", bytes: 1, expiresAt: 123 };
      },
    },
    maxRecords: 2,
    maxActive: 1,
    operationTimeoutMs: 20,
  });
  const alice = new EventEmitter(),
    bob = new EventEmitter();
  manager.attach({ sessionId: "a", tabId: "a" }, alice, "alice");
  manager.attach({ sessionId: "b", tabId: "b" }, bob, "bob");
  alice.emit("download", native());
  const id = manager.list("a")[0].id;
  await manager.wait("a", id);
  bob.emit("download", native(true));
  bob.emit("download", native());
  assert.equal(manager.inspect("a", id).state, "complete");
  assert.equal(manager.saturation("a").evicted, 0);
  assert.equal(manager.saturation("b").rejected, 1);
  await manager.cancel("b", manager.list("b")[0].id);
  bob.emit("download", native());
  assert.equal(manager.inspect("a", id).state, "complete");
  assert.equal(manager.saturation("a").evicted, 0);
  await manager.shutdown();
});

test("per-owner capacity isolates records and total saturation is explicit", async () => {
  const manager = new DownloadManager({
    sink: {
      async putBinary(_owner, stream) {
        for await (const _ of stream) {
        }
        return { id: "id", path: "/private", bytes: 1, expiresAt: 123 };
      },
    },
    maxRecords: 1,
    maxTotalRecords: 2,
  });
  const a = new EventEmitter(),
    b = new EventEmitter(),
    c = new EventEmitter();
  manager.attach({ sessionId: "a", tabId: "t" }, a, "alice");
  manager.attach({ sessionId: "b", tabId: "t" }, b, "bob");
  manager.attach({ sessionId: "c", tabId: "t" }, c, "carol");
  a.emit("download", native());
  const aid = manager.list("a")[0].id;
  await manager.wait("a", aid);
  b.emit("download", native());
  const bid = manager.list("b")[0].id;
  await manager.wait("b", bid);
  c.emit("download", native());
  assert.equal(manager.list("c").length, 0);
  assert.equal(manager.saturation("c").rejectionReasons.totalLimit, 1);
  assert.equal(manager.inspect("a", aid).state, "complete");
  assert.equal(manager.inspect("b", bid).state, "complete");
  await manager.endSession("b");
  c.emit("download", native());
  assert.equal(
    (await manager.wait("c", manager.list("c")[0].id)).state,
    "complete",
  );
  assert.equal(manager.inspect("a", aid).state, "complete");
  await manager.shutdown();
});

test("managed browser disposal tracking is reaped after settlement", async () => {
  const sessions = new ManagedSessions({ launch: async () => browser() });
  for (let i = 0; i < 300; i++) {
    const target = await sessions.start();
    await sessions.stop(target.sessionId);
  }
  assert.equal((sessions as any).disposals.size, 0);
  assert.equal((sessions as any).owned.size, 0);
  assert.equal((await sessions.shutdown()).complete, true);
});

test("closed-session bookkeeping is bounded and stale listeners cannot resurrect records", async () => {
  const manager = new DownloadManager({
    sink: {
      async putBinary() {
        throw new Error("unexpected");
      },
    },
    maxClosedSessions: 7,
  });
  let stale!: (download: NativeDownload) => void;
  for (let i = 0; i < 300; i++) {
    const page = new EventEmitter(),
      sessionId = `s${i}`;
    manager.attach({ sessionId, tabId: "t" }, page, `owner${i}`);
    if (i === 0)
      stale = page.listeners("download")[0] as (
        download: NativeDownload,
      ) => void;
    const result = await manager.endSession(sessionId);
    assert.equal(result.cleanup, "complete");
  }
  const internal = manager as any;
  assert.equal(internal.owners.size, 0);
  assert.equal(internal.endings.size, 0);
  assert.equal(internal.closeReports.size, 7);
  assert.equal(internal.rejected.size, 0);
  assert.equal(internal.warnings.size, 0);
  const page = new EventEmitter();
  manager.attach({ sessionId: "s0", tabId: "t" }, page, "new-owner");
  let cancelled = false,
    deleted = false;
  const old = native();
  old.cancel = async () => {
    cancelled = true;
  };
  old.delete = async () => {
    deleted = true;
  };
  stale(old);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(deleted, true);
  assert.equal(manager.list("s0").length, 0);
  assert.equal(manager.saturation("s0").rejected, 0);
  assert.equal(manager.owns("s0", "new-owner"), true);
  await manager.shutdown();
});
