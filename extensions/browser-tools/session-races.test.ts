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
class FakePage extends EventEmitter {
  closed = false;
  gate = deferred<void>();
  url() {
    return "about:blank";
  }
  isClosed() {
    return this.closed;
  }
  async close() {
    this.closed = true;
    this.emit("close");
  }
  async goto() {
    await this.gate.promise;
  }
}
class FakeBrowser extends EventEmitter {
  page = new FakePage();
  contextGate?: ReturnType<typeof deferred<void>>;
  closes = 0;
  failClose = false;
  async newContext() {
    if (this.contextGate) await this.contextGate.promise;
    return { newPage: async () => this.page };
  }
  async close() {
    this.closes++;
    if (this.failClose) throw new Error("close failed");
    await this.page.close();
    this.emit("disconnected");
  }
}

test("abort closes a launched browser even while context creation hangs", async () => {
  const browser = new FakeBrowser();
  browser.contextGate = deferred<void>();
  const runtime = new ManagedSessions({ launch: async () => browser as never });
  const signal = new AbortController();
  const start = runtime.start({ signal: signal.signal });
  await new Promise((r) => setImmediate(r));
  signal.abort();
  await assert.rejects(start, /startup cancelled/);
  await new Promise((r) => setImmediate(r));
  assert.equal(browser.closes, 1);
  assert.equal((await runtime.shutdown(5)).complete, false);
  browser.contextGate.resolve();
  await new Promise((r) => setImmediate(r));
  assert.equal(browser.closes, 1);
  assert.equal((await runtime.shutdown()).complete, true);
});

test("shutdown closes launched browser even without an abort signal", async () => {
  const browser = new FakeBrowser();
  browser.contextGate = deferred<void>();
  const runtime = new ManagedSessions({ launch: async () => browser as never });
  const start = runtime.start();
  await new Promise((r) => setImmediate(r));
  assert.equal((await runtime.shutdown(5)).complete, false);
  assert.equal(browser.closes, 1);
  browser.contextGate.resolve();
  await assert.rejects(start, /startup cancelled/);
  assert.equal((await runtime.shutdown()).complete, true);
});

test("stop invalidates before concurrent operation settles and reports uncertain dispatch", async () => {
  const browser = new FakeBrowser();
  const runtime = new ManagedSessions({ launch: async () => browser as never });
  const target = await runtime.start();
  const navigation = runtime.navigate("http://example.test", target);
  await assert.rejects(runtime.newTab(target.sessionId), /busy/);
  await runtime.stop(target.sessionId);
  assert.equal(browser.closes, 1);
  await assert.rejects(
    runtime.navigate("http://example.test", target),
    /unavailable/,
  );
  browser.page.gate.resolve();
  await assert.rejects(
    navigation,
    /already dispatched action may have occurred/,
  );
  assert.equal((await runtime.shutdown()).complete, true);
});

test("failed cleanup remains visible across repeated shutdown calls", async () => {
  const browser = new FakeBrowser();
  const runtime = new ManagedSessions({ launch: async () => browser as never });
  await runtime.start();
  browser.failClose = true;
  assert.equal((await runtime.shutdown()).complete, false);
  assert.equal((await runtime.shutdown()).complete, false);
  assert.equal(browser.closes, 1);
});

test("late launch rejection after cancellation keeps shutdown cleanup unverified", async () => {
  let rejectLaunch!: (error: Error) => void;
  const launch = new Promise<never>((_, reject) => {
    rejectLaunch = reject;
  });
  const runtime = new ManagedSessions({ launch: () => launch });
  const controller = new AbortController();
  const start = runtime.start({ signal: controller.signal });
  controller.abort();
  await assert.rejects(start, /process cleanup cannot be verified/);
  assert.equal((await runtime.shutdown(5)).complete, false);
  rejectLaunch(new Error("late failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await runtime.shutdown()).complete, false);
  assert.equal((await runtime.shutdown()).complete, false);
});

test("disposable startup rejects disconnect during context creation", async () => {
  const browser = new FakeBrowser();
  browser.contextGate = deferred<void>();
  const runtime = new ManagedSessions({ launch: async () => browser as never });
  const startup = runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  browser.emit("disconnected");
  browser.contextGate.resolve();
  await assert.rejects(startup, /disconnected or closed/);
  assert.deepEqual(runtime.list(), []);
  assert.equal((await runtime.shutdown()).complete, false);
});
test("disposable startup rejects disconnect during page creation", async () => {
  const browser = new FakeBrowser();
  const pageGate = deferred<FakePage>();
  let dispatched!: () => void;
  const ready = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  browser.newContext = async () => ({
    newPage: async () => {
      dispatched();
      return pageGate.promise;
    },
  });
  const runtime = new ManagedSessions({ launch: async () => browser as never });
  const startup = runtime.start();
  await ready;
  browser.emit("disconnected");
  pageGate.resolve(browser.page);
  await assert.rejects(startup, /disconnected or closed/);
  assert.deepEqual(runtime.list(), []);
  assert.equal((await runtime.shutdown()).complete, false);
});
test("pre-aborted requests never launch or close resources", async () => {
  let launches = 0;
  const runtime = new ManagedSessions({
    launch: async () => {
      launches++;
      return new FakeBrowser() as never;
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runtime.start({ signal: controller.signal }),
    /before dispatch/,
  );
  assert.equal(launches, 0);
  await runtime.shutdown();
});
