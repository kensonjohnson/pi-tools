import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { pickHumanElement } from "./human-picker.ts";

function fixture(acquisition: Promise<any>) {
  const page = new EventEmitter() as any;
  page.frames = () => [{}];
  page.context = () => ({ newCDPSession: () => acquisition });
  const browser = new EventEmitter() as any;
  return { page, browser };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("picker rejects invalid selection bounds before acquiring a session", async () => {
  for (const maxSelections of [0, 21, 1.5, NaN]) {
    const { page, browser } = fixture(new Promise(() => {}));
    await assert.rejects(
      pickHumanElement({
        page,
        browser,
        maxSelections,
        onUncertainFailure: () => {},
      }),
      RangeError,
    );
    assert.equal(page.listenerCount("framenavigated"), 0);
  }
});

test(
  "abort during hung CDP acquisition returns boundedly and quarantines",
  { timeout: 1000 },
  async () => {
    const { page, browser } = fixture(new Promise(() => {}));
    const abort = new AbortController();
    let failures = 0;
    const pending = pickHumanElement({
      page,
      browser,
      signal: abort.signal,
      onUncertainFailure: () => {
        failures++;
      },
    });
    abort.abort();
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.equal(failures, 1);
    assert.equal(page.listenerCount("framenavigated"), 0);
    assert.equal(browser.listenerCount("disconnected"), 0);
  },
);

test(
  "abandoned acquisition detaches a late CDP session",
  { timeout: 1000 },
  async () => {
    const acquisition = deferred<any>();
    const { page, browser } = fixture(acquisition.promise);
    const abort = new AbortController();
    let quarantined = 0;
    let detached = 0;
    const pending = pickHumanElement({
      page,
      browser,
      signal: abort.signal,
      onUncertainFailure: () => {
        quarantined++;
      },
    });
    abort.abort();
    assert.equal((await pending).status, "cancelled");
    assert.equal(quarantined, 1);
    acquisition.resolve({
      detach: async () => {
        detached++;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(detached, 1);
  },
);

test(
  "late child CDP acquisition is detached after abort",
  { timeout: 1000 },
  async () => {
    const child = deferred<any>();
    const root = new EventEmitter() as any;
    root.send = async (method: string) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "root" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 1 };
      return {};
    };
    root.detach = async () => {};
    const page = new EventEmitter() as any;
    const main = {};
    const frame = {};
    page.frames = () => [main, frame];
    page.mainFrame = () => main;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    page.context = () => ({
      newCDPSession: (target: unknown) => {
        if (target === page) return Promise.resolve(root);
        started();
        return child.promise;
      },
    });
    const browser = new EventEmitter() as any;
    const abort = new AbortController();
    let quarantined = 0;
    let detached = 0;
    const pending = pickHumanElement({
      page,
      browser,
      signal: abort.signal,
      onUncertainFailure: () => {
        quarantined++;
      },
    });
    await startedPromise;
    abort.abort();
    assert.equal((await pending).status, "cancelled");
    child.resolve({
      detach: async () => {
        detached++;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(detached, 1);
    assert.equal(quarantined, 1);
  },
);

for (const scenario of [
  "active-cleanup-failure",
  "removed-unexpected-error",
  "unexpected-disconnect",
]) {
  test(`quarantines on ${scenario}`, { timeout: 1000 }, async () => {
    const ready = deferred<void>();
    let removing = false;
    const makeSession = (isRoot: boolean) => {
      const session = new EventEmitter() as any;
      session.send = async (method: string, params: any) => {
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "root" } } };
        if (method === "Page.createIsolatedWorld")
          return { executionContextId: 1 };
        if (
          isRoot &&
          method === "Input.setIgnoreInputEvents" &&
          params.ignore === false
        )
          ready.resolve();
        if (
          !isRoot &&
          method === "Overlay.setInspectMode" &&
          params.mode === "none"
        ) {
          if (scenario === "active-cleanup-failure")
            throw new Error("Target page, context or browser has been closed");
          if (scenario === "removed-unexpected-error")
            throw new Error("protocol failed unexpectedly");
        }
        return {};
      };
      session.detach = async () => {};
      return session;
    };
    const root = makeSession(true);
    const child = makeSession(false);
    const page = new EventEmitter() as any;
    const main = {};
    const frame = { isDetached: () => removing };
    page.frames = () => [main, frame];
    page.mainFrame = () => main;
    page.isClosed = () => false;
    page.context = () => ({
      newCDPSession: async (target: unknown) =>
        target === page ? root : child,
    });
    const browser = new EventEmitter() as any;
    browser.isConnected = () => true;
    let failures = 0;
    const pending = pickHumanElement({
      page,
      browser,
      onUncertainFailure: () => {
        failures++;
      },
    });
    await ready.promise;
    await new Promise((resolve) => setImmediate(resolve));
    if (scenario === "unexpected-disconnect") child.emit("Disconnected");
    else if (scenario === "removed-unexpected-error") {
      removing = true;
      page.emit("framedetached", frame);
    } else page.emit("frameattached", {});
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.match(result.reason, /cleanup uncertain/);
    assert.equal(failures, 1);
  });
}

test(
  "a hung late detach stays bounded and leaves the owner quarantined",
  { timeout: 4000 },
  async () => {
    const acquisition = deferred<any>();
    const { page, browser } = fixture(acquisition.promise);
    const abort = new AbortController();
    let quarantined = 0;
    const pending = pickHumanElement({
      page,
      browser,
      signal: abort.signal,
      onUncertainFailure: () => {
        quarantined++;
      },
    });
    abort.abort();
    assert.equal((await pending).status, "cancelled");
    acquisition.resolve({ detach: () => new Promise(() => {}) });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.equal(quarantined, 1);
  },
);

test(
  "late acquisition and detach failures do not cause unhandled rejections",
  { timeout: 1000 },
  async () => {
    for (const failure of ["acquire", "detach"]) {
      const acquisition = deferred<any>();
      const { page, browser } = fixture(acquisition.promise);
      const abort = new AbortController();
      let quarantined = 0;
      const pending = pickHumanElement({
        page,
        browser,
        signal: abort.signal,
        onUncertainFailure: () => {
          quarantined++;
          return Promise.reject(new Error("cleanup failed"));
        },
      });
      abort.abort();
      assert.equal((await pending).status, "cancelled");
      if (failure === "acquire")
        acquisition.reject(new Error("late acquisition failed"));
      else
        acquisition.resolve({
          detach: () => Promise.reject(new Error("late detach failed")),
        });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(quarantined, 1);
    }
  },
);
