import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedBrowserExtension } from "./registration.ts";
import { ManagedSessions } from "./sessions.ts";
import { ArtifactStore } from "./artifacts.ts";
import { DownloadManager } from "./downloads.ts";

test("staged download tools subscribe before navigation and scope artifacts to creator", async () => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "download-registration-")),
  );
  const handlers = new Map<string, Function>(),
    tools = new Map<string, any>();
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
  const page = new EventEmitter() as any,
    browser = new EventEmitter() as any;
  let closed = false;
  page.isClosed = () => closed;
  page.url = () => "https://example.test";
  page.close = async () => {
    closed = true;
    page.emit("close");
  };
  page.goto = async () => {
    assert.equal(page.listenerCount("download"), 1);
    page.emit("download", {
      url: () => "https://u:p@example.test/?token=secret",
      suggestedFilename: () => "../fixture.bin",
      failure: async () => null,
      createReadStream: async () => Readable.from([Buffer.from([0, 255, 1])]),
      cancel: async () => {},
      delete: async () => {},
    });
  };
  browser.newContext = async () => ({ newPage: async () => page });
  browser.close = async () => {
    await page.close();
    browser.emit("disconnected");
  };
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createArtifacts: () => new ArtifactStore({ root: join(dir, "store") }),
    createInstaller: () => ({ ensure: async () => ({ ok: true }) }) as never,
    createSessions: (diagnostics, downloads) =>
      new ManagedSessions({
        launch: async () => browser,
        diagnostics,
        downloads,
      }),
  });
  const ctx = (id: string) => ({
    cwd: dir,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => id },
  });
  const call = async (
    name: string,
    args: any,
    owner = "creator",
    signal?: AbortSignal,
  ) =>
    JSON.parse(
      (await tools.get(name).execute("id", args, signal, undefined, ctx(owner)))
        .content[0].text,
    );
  try {
    await handlers.get("session_start")!({}, ctx("creator"));
    assert.ok(active.includes("browser_download"));
    const target = await call("browser_session", { action: "start" });
    await call("browser_navigate", { ...target, url: "https://example.test" });
    const list = await call("browser_download", {
      action: "list",
      sessionId: target.sessionId,
    });
    assert.equal(list.downloads.length, 1);
    assert.doesNotMatch(list.downloads[0].url, /secret|u:p/);
    await assert.rejects(
      call(
        "browser_download",
        { action: "list", sessionId: target.sessionId },
        "other",
      ),
      /owned by another/,
    );
    const done = await call("browser_download", {
      action: "wait",
      sessionId: target.sessionId,
      id: list.downloads[0].id,
    });
    assert.equal(done.state, "complete");
    await assert.rejects(
      call(
        "browser_artifact",
        { action: "read_binary", id: done.artifact.id },
        "other",
      ),
      /owned by another/,
    );
    const chunk = await call("browser_artifact", {
      action: "read_binary",
      id: done.artifact.id,
    });
    assert.deepEqual(
      Buffer.from(chunk.data, "base64"),
      Buffer.from([0, 255, 1]),
    );
    await call("browser_session", {
      action: "stop",
      sessionId: target.sessionId,
    });
    assert.deepEqual(
      await readFile(done.artifact.path),
      Buffer.from([0, 255, 1]),
    );
    await handlers.get("session_shutdown")!();
    assert.ok(!active.includes("browser_download"));
  } finally {
    await handlers.get("session_shutdown")?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("overflow closes only its owned browser and reports unverified cleanup", async () => {
  const browser = new EventEmitter() as any,
    page = new EventEmitter() as any;
  let closed = false;
  page.isClosed = () => false;
  page.url = () => "about:blank";
  page.close = async () => {};
  browser.newContext = async () => ({ newPage: async () => page });
  browser.close = async () => {
    closed = true;
    browser.emit("disconnected");
  };
  let sessions!: ManagedSessions;
  const downloads = new DownloadManager({
    sink: { putBinary: async () => new Promise(() => {}) },
    maxActive: 1,
    maxRecords: 1,
    operationTimeoutMs: 20,
    onOverflow: (id) => sessions.failClosed(id),
  });
  sessions = new ManagedSessions({
    launch: async () => browser,
    downloads,
    downloadCloseTimeoutMs: 100,
  });
  const target = await sessions.start();
  const n = () => ({
    url: () => "https://example.test",
    suggestedFilename: () => "a",
    failure: () => new Promise(() => {}),
    createReadStream: async () => null,
    cancel: () => new Promise(() => {}),
    delete: async () => {},
  });
  page.emit("download", n());
  page.emit("download", n());
  page.emit("download", n());
  const result = await sessions.shutdown(1000);
  assert.equal(result.complete, false);
  assert.equal(
    downloads.saturation(target.sessionId).closedCleanup?.cleanup,
    "unverified",
  );
  assert.equal(closed, true);
  assert.equal(downloads.owns(target.sessionId, target.sessionId), true);
});
