import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ManagedSessions } from "./sessions.ts";
import { DownloadManager } from "./downloads.ts";
import { BrowserDiagnostics } from "./diagnostics.ts";

function setup(
  options: {
    failClose?: boolean;
    hangClose?: boolean;
    failListener?: string;
    failOff?: string;
  } = {},
) {
  const pages: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const browser = new EventEmitter() as any;
  browser.newContext = async () => ({
    newPage: async () => {
      const page = new EventEmitter() as any;
      let closed = false;
      page.isClosed = () => closed;
      page.url = () => "about:blank";
      page.close = async () => {
        if (options.failClose && pages.indexOf(page) === 1)
          throw new Error("page close failed");
        if (options.hangClose && pages.indexOf(page) === 1) await gate;
        closed = true;
        page.emit("close");
      };
      const on = page.on.bind(page);
      page.on = (name: string, listener: Function) => {
        const result = on(name, listener);
        if (pages.indexOf(page) === 1 && name === options.failListener)
          throw new Error("listener fault");
        return result;
      };
      const off = page.off.bind(page);
      page.off = (name: string, listener: Function) => {
        if (pages.indexOf(page) === 1 && name === options.failOff)
          throw new Error("listener removal fault");
        return off(name, listener);
      };
      pages.push(page);
      return page;
    },
  });
  browser.close = async () => {
    for (const page of pages)
      if (!page.isClosed()) {
        try {
          await page.close();
        } catch {}
      }
    browser.emit("disconnected");
  };
  const downloads = new DownloadManager({
    sink: {
      async putBinary() {
        throw new Error("unexpected");
      },
    },
    maxPages: options.failListener || options.failOff ? 10 : 1,
  });
  const diagnostics = new BrowserDiagnostics();
  let n = 0;
  const sessions = new ManagedSessions({
    launch: async () => browser,
    diagnostics,
    downloads,
    id: () => `id${++n}`,
    downloadCloseTimeoutMs: 20,
  });
  return { sessions, pages, diagnostics, downloads, release };
}

test("capacity rejection closes only the new page and removes partial diagnostics", async () => {
  const { sessions, pages, diagnostics } = setup();
  try {
    const first = await sessions.start();
    await assert.rejects(sessions.newTab(first.sessionId), /page capacity/);
    assert.equal(pages.length, 2);
    assert.equal(pages[0].isClosed(), false);
    assert.equal(pages[1].isClosed(), true);
    assert.equal(pages[1].listenerCount("console"), 0);
    assert.equal(pages[1].listenerCount("download"), 0);
    assert.equal(pages[1].listenerCount("close"), 0);
    assert.equal(sessions.list()[0].tabs.length, 1);
    assert.throws(
      () => diagnostics.read({ sessionId: first.sessionId, tabId: "id3" }),
      /unavailable/,
    );
  } finally {
    assert.equal((await sessions.shutdown()).complete, true);
  }
});

test("partial listener registration is unwound on both diagnostics and download faults", async () => {
  for (const failListener of ["request", "download", "close"]) {
    const { sessions, pages } = setup({ failListener });
    try {
      const first = await sessions.start();
      await assert.rejects(sessions.newTab(first.sessionId), /listener fault/);
      assert.equal(pages[1].isClosed(), true);
      for (const event of ["console", "request", "download", "close"])
        assert.equal(
          pages[1].listenerCount(event),
          0,
          `${failListener}: ${event}`,
        );
      assert.equal(sessions.list()[0].tabs.length, 1);
    } finally {
      assert.equal((await sessions.shutdown()).complete, true);
    }
  }
});

test("registration plus removal failures invalidate the session and shutdown reports incomplete", async () => {
  for (const [failListener, failOff] of [
    ["request", "console"],
    ["download", "download"],
  ]) {
    const { sessions, pages } = setup({ failListener, failOff });
    const external = new EventEmitter();
    let externalCalls = 0;
    external.on("console", () => {
      externalCalls++;
    });
    const first = await sessions.start();
    await assert.rejects(
      sessions.newTab(first.sessionId),
      /registration cleanup unverified/,
    );
    assert.deepEqual(sessions.list(), []);
    assert.equal((await sessions.shutdown(1000)).complete, false);
    assert.equal(pages[0].isClosed(), true);
    assert.equal(pages[1].isClosed(), true);
    external.emit("console");
    assert.equal(externalCalls, 1);
    assert.equal(external.listenerCount("console"), 1);
  }
});

test("shutdown remains incomplete instead of throwing when active diagnostics removal fails", async () => {
  const { sessions, pages } = setup({ failOff: "console" });
  const first = await sessions.start();
  await sessions.newTab(first.sessionId);
  const result = await sessions.shutdown(1000);
  assert.equal(result.complete, false);
  assert.equal(pages[0].isClosed(), true);
  assert.equal(pages[1].isClosed(), true);
});

test("hung unregistered page close is bounded and requests owned browser cleanup", async () => {
  const { sessions, release } = setup({ hangClose: true });
  try {
    const first = await sessions.start();
    await assert.rejects(
      sessions.newTab(first.sessionId),
      /cleanup unverified/,
    );
  } finally {
    release();
    assert.equal((await sessions.shutdown(1000)).complete, false);
  }
});

test("failed unregistered page close invalidates owned browser and reports cleanup uncertainty", async () => {
  const { sessions } = setup({ failClose: true });
  const first = await sessions.start();
  await assert.rejects(sessions.newTab(first.sessionId), /cleanup unverified/);
  assert.equal((await sessions.shutdown()).complete, false);
});
