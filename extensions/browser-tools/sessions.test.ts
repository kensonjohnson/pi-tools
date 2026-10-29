import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ManagedSessions } from "./sessions.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class Page extends EventEmitter {
  closed = false;
  current = "about:blank";
  gate?: ReturnType<typeof deferred<void>>;
  isClosed() {
    return this.closed;
  }
  url() {
    return this.current;
  }
  async goto(url: string) {
    await this.gate?.promise;
    this.current = url;
  }
  async close() {
    this.closed = true;
    this.emit("close");
  }
}
class Context {
  pages: Page[] = [];
  async newPage() {
    const page = new Page();
    this.pages.push(page);
    return page;
  }
}
class Browser extends EventEmitter {
  context = new Context();
  closed = false;
  async newContext() {
    return this.context;
  }
  async close() {
    this.closed = true;
    for (const page of this.context.pages) await page.close();
    this.emit("disconnected");
  }
}
function fixture() {
  const browsers: Browser[] = [];
  const runtime = new ManagedSessions({
    launch: async () => {
      const browser = new Browser();
      browsers.push(browser);
      return browser as never;
    },
  });
  return { runtime, browsers };
}

test("factories isolate targets and tab loss never reselects", async () => {
  const a = fixture(),
    b = fixture();
  const first = await a.runtime.start(),
    other = await b.runtime.start();
  const second = await a.runtime.newTab();
  await a.runtime.navigate("https://example.test/one", first);
  assert.equal(
    a.browsers[0].context.pages[0].url(),
    "https://example.test/one",
  );
  assert.equal(a.browsers[0].context.pages[1].url(), "about:blank");
  await assert.rejects(
    b.runtime.navigate("https://example.test", first),
    /Session unavailable/,
  );
  await a.runtime.closeTab(second);
  await assert.rejects(
    a.runtime.navigate("https://example.test"),
    /Session unavailable/,
  );
  a.runtime.select(first);
  await a.runtime.navigate("https://example.test/two");
  assert.equal(b.browsers[0].context.pages[0].url(), "about:blank");
  assert.equal(b.runtime.list()[0].sessionId, other.sessionId);
  await Promise.all([a.runtime.shutdown(), b.runtime.shutdown()]);
});

test("abort invalidates the owned session and reports uncertain dispatch", async () => {
  const { runtime, browsers } = fixture();
  const target = await runtime.start();
  const page = browsers[0].context.pages[0];
  page.gate = deferred<void>();
  const controller = new AbortController();
  const navigation = runtime.navigate(
    "https://example.test",
    target,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(
    navigation,
    /already dispatched action may have occurred/,
  );
  assert.equal(browsers[0].closed, true);
  await assert.rejects(
    runtime.navigate("https://example.test", target),
    /Session unavailable/,
  );
  page.gate.resolve();
  await runtime.shutdown();
});

test("hung video context close still closes browser and retains unverified video", async () => {
  const browser = new Browser();
  const gate = deferred<void>();
  Object.assign(browser.context, { close: async () => gate.promise });
  let unverified = false,
    finalized = false;
  const videos = {
    prepare: async () => "/private/video",
    attach: () => {},
    markUnverified: () => {
      unverified = true;
    },
    closed: async () => {
      finalized = true;
      return true;
    },
  };
  const runtime = new ManagedSessions({
    launch: async () => browser as never,
    videos: videos as never,
    downloadCloseTimeoutMs: 20,
  });
  const target = await runtime.start({ video: true, artifactOwner: "owner" });
  await assert.rejects(
    runtime.stop(target.sessionId, 1000, undefined, "owner"),
    /context close timed out/,
  );
  assert.equal(browser.closed, true);
  assert.equal(unverified, true);
  assert.equal(finalized, false);
  gate.resolve();
  assert.equal((await runtime.shutdown(1000)).complete, false);
});

test("video status becomes unknown while context and browser closes both hang", async () => {
  const browser = new Browser();
  const contextGate = deferred<void>(),
    browserGate = deferred<void>();
  Object.assign(browser.context, { close: async () => contextGate.promise });
  let browserCloseStarted = false,
    state = "recording",
    finalized = false;
  Object.assign(browser, {
    close: async () => {
      browserCloseStarted = true;
      await browserGate.promise;
      browser.closed = true;
    },
  });
  const videos = {
    prepare: async () => "/private/video",
    attach: () => {},
    markUnverified: () => {
      state = "unknown";
    },
    closed: async () => {
      finalized = true;
      state = "complete";
      return true;
    },
  };
  const runtime = new ManagedSessions({
    launch: async () => browser as never,
    videos: videos as never,
    downloadCloseTimeoutMs: 20,
  });
  const target = await runtime.start({ video: true, artifactOwner: "owner" });
  const stopping = runtime.stop(target.sessionId, 60, undefined, "owner");
  assert.equal(state, "unknown");
  await assert.rejects(stopping, /deadline exceeded/);
  assert.equal(browserCloseStarted, true);
  assert.equal(state, "unknown");
  assert.equal(finalized, false);
  assert.equal((await runtime.shutdown(10)).complete, false);
  contextGate.resolve();
  browserGate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(state, "unknown");
  assert.equal(finalized, false);
});

test("aborted late launch is closed and shutdown invalidates immediately", async () => {
  const gate = deferred<Browser>();
  const runtime = new ManagedSessions({ launch: () => gate.promise as never });
  const controller = new AbortController();
  const start = runtime.start({ signal: controller.signal });
  controller.abort();
  await assert.rejects(start, /startup cancelled/);
  const result = await runtime.shutdown(5);
  assert.equal(result.complete, false);
  const browser = new Browser();
  gate.resolve(browser);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(browser.closed, true);
  await assert.rejects(runtime.start(), /shut down/);
});
