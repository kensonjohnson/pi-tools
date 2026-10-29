import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, mkdir, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedSessions } from "./sessions.ts";
import { acquireProfile } from "./profiles.ts";

class FakePage extends EventEmitter {
  isClosed() {
    return false;
  }
  url() {
    return "about:blank";
  }
  async goto() {
    await new Promise(() => {});
  }
}
class FakeBrowser extends EventEmitter {}
class FakeContext {
  browserObject = new FakeBrowser();
  page = new FakePage();
  failedClose = false;
  browser() {
    return this.browserObject;
  }
  pages() {
    return [this.page];
  }
  async close() {
    if (this.failedClose) throw Error("close failed");
    this.browserObject.emit("disconnected");
  }
}
const make = (
  root: string,
  launchPersistent: (...args: any[]) => Promise<any>,
) =>
  new ManagedSessions({
    root: undefined,
    profileRoot: root,
    launch: async () => {
      throw Error("unused");
    },
    launchPersistent,
  } as any);

test("unsafe nested profile symlink prevents browser launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-session-test-"));
  const outside = await mkdtemp(join(tmpdir(), "profile-outside-test-"));
  try {
    await mkdir(join(root, "profile-bad"));
    await symlink(outside, join(root, "profile-bad", "Default"));
    let launched = false;
    const runtime = make(root, async () => {
      launched = true;
      return new FakeContext();
    });
    await assert.rejects(
      runtime.start({ profile: "bad" }),
      /Unsafe profile entry/,
    );
    assert.equal(launched, false);
    assert.deepEqual(await readdir(outside), []);
    await runtime.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
test("failed persistent launch and failed close retain ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-session-test-"));
  try {
    const failed = make(root, async () => {
      throw Error("launch failed");
    });
    await assert.rejects(
      failed.start({ profile: "launch" }),
      /failed to launch/,
    );
    await assert.rejects(
      acquireProfile("launch", { root, timeoutMs: 100 }),
      /timed out/,
    );
    const context = new FakeContext();
    context.failedClose = true;
    const runtime = make(root, async () => context);
    await runtime.start({ profile: "close" });
    await assert.rejects(runtime.stop(), /close failed/);
    await assert.rejects(
      acquireProfile("close", { root, timeoutMs: 100 }),
      /timed out/,
    );
    assert.equal((await runtime.shutdown()).complete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("cancelled operation releases profile after context close succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-session-test-"));
  try {
    const runtime = make(root, async () => new FakeContext());
    await runtime.start({ profile: "cancel" });
    const controller = new AbortController();
    const navigation = runtime.navigate(
      "http://example.test",
      undefined,
      controller.signal,
    );
    controller.abort();
    await assert.rejects(navigation, /cancelled/);
    const next = await acquireProfile("cancel", { root, timeoutMs: 2000 });
    await next.release();
    await runtime.shutdown(20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("cancellation immediately after acquisition releases before launch dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-session-test-"));
  try {
    const controller = new AbortController();
    let launched = false;
    const runtime = new ManagedSessions({
      profileRoot: root,
      launch: async () => {
        throw Error("unused");
      },
      launchPersistent: async () => {
        launched = true;
        return new FakeContext() as never;
      },
      acquireProfile: async (name, options) => {
        const lease = await acquireProfile(name, options);
        controller.abort();
        return lease;
      },
    });
    await assert.rejects(
      runtime.start({ profile: "before", signal: controller.signal }),
      /cancelled/,
    );
    const lease = await acquireProfile("before", { root, timeoutMs: 2000 });
    assert.equal(launched, false);
    await lease.release();
    await runtime.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("cancelled navigation retains lease while context close hangs and releases after it finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-session-test-"));
  try {
    const context = new FakeContext();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    context.close = async () => {
      await gate;
      context.browserObject.emit("disconnected");
    };
    const runtime = make(root, async () => context);
    await runtime.start({ profile: "hanging" });
    const controller = new AbortController();
    const operation = runtime.navigate(
      "http://example.test",
      undefined,
      controller.signal,
    );
    controller.abort();
    await assert.rejects(operation, /cancelled/);
    await assert.rejects(
      acquireProfile("hanging", { root, timeoutMs: 100 }),
      /timed out/,
    );
    finish();
    const lease = await acquireProfile("hanging", { root, timeoutMs: 2000 });
    await lease.release();
    await runtime.shutdown(20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("cancelled startup releases a late-returned browser after successful close", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-session-test-"));
  try {
    let finish!: (context: FakeContext) => void;
    let dispatched!: () => void;
    const ready = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const pending = new Promise<FakeContext>((resolve) => {
      finish = resolve;
    });
    const runtime = make(root, async () => {
      dispatched();
      return pending;
    });
    const controller = new AbortController();
    const startup = runtime.start({
      profile: "late",
      signal: controller.signal,
    });
    await ready;
    controller.abort();
    await assert.rejects(startup, /cancelled/);
    await assert.rejects(
      acquireProfile("late", { root, timeoutMs: 100 }),
      /timed out/,
    );
    finish(new FakeContext());
    const lease = await acquireProfile("late", { root, timeoutMs: 2000 });
    await lease.release();
    await runtime.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("launch rejection after cancellation remains quarantined", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-session-test-"));
  try {
    let fail!: (error: Error) => void;
    let dispatched!: () => void;
    const ready = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const pending = new Promise<FakeContext>((_, reject) => {
      fail = reject;
    });
    const runtime = make(root, async () => {
      dispatched();
      return pending;
    });
    const controller = new AbortController();
    const startup = runtime.start({
      profile: "reject",
      signal: controller.signal,
    });
    await ready;
    controller.abort();
    await assert.rejects(startup, /cancelled/);
    fail(new Error("unknown launch outcome"));
    assert.equal((await runtime.shutdown()).complete, false);
    await assert.rejects(
      acquireProfile("reject", { root, timeoutMs: 100 }),
      /timed out/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("aborting stop releases the profile when delayed close succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-session-test-"));
  try {
    const context = new FakeContext();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    context.close = async () => {
      await gate;
      context.browserObject.emit("disconnected");
    };
    const runtime = make(root, async () => context);
    await runtime.start({ profile: "stop" });
    const controller = new AbortController();
    const stop = runtime.stop(undefined, 2000, controller.signal);
    controller.abort();
    await assert.rejects(stop, /cancelled/);
    await assert.rejects(
      acquireProfile("stop", { root, timeoutMs: 100 }),
      /timed out/,
    );
    finish();
    const lease = await acquireProfile("stop", { root, timeoutMs: 2000 });
    await lease.release();
    await runtime.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("failed close after cancellation keeps the profile blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-session-test-"));
  try {
    const context = new FakeContext();
    context.failedClose = true;
    const runtime = make(root, async () => context);
    await runtime.start({ profile: "failed-abort" });
    const controller = new AbortController();
    const operation = runtime.navigate(
      "http://example.test",
      undefined,
      controller.signal,
    );
    controller.abort();
    await assert.rejects(operation, /cancelled/);
    await assert.rejects(
      acquireProfile("failed-abort", { root, timeoutMs: 200 }),
      /timed out/,
    );
    assert.equal((await runtime.shutdown(20)).complete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("disconnect before cancellation cleanup dispatch remains unverified", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-session-test-"));
  try {
    const context = new FakeContext();
    const runtime = make(root, async () => context);
    await runtime.start({ profile: "disconnect-race" });
    const controller = new AbortController();
    const operation = runtime.navigate(
      "http://example.test",
      undefined,
      controller.signal,
    );
    controller.abort();
    context.browserObject.emit("disconnected");
    await assert.rejects(operation, /cancelled/);
    await assert.rejects(
      acquireProfile("disconnect-race", { root, timeoutMs: 100 }),
      /timed out/,
    );
    assert.equal((await runtime.shutdown(20)).complete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("persistent startup rejects disconnect while newPage is pending and retains the lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-session-test-"));
  try {
    const context = new FakeContext();
    let resolvePage!: (page: FakePage) => void;
    let dispatched!: () => void;
    const ready = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const pending = new Promise<FakePage>((resolve) => {
      resolvePage = resolve;
    });
    context.pages = () => [];
    (context as any).newPage = () => {
      dispatched();
      return pending;
    };
    const runtime = make(root, async () => context);
    const startup = runtime.start({ profile: "page-race" });
    await ready;
    context.browserObject.emit("disconnected");
    resolvePage(context.page);
    await assert.rejects(startup, /disconnected or closed/);
    assert.deepEqual(runtime.list(), []);
    await assert.rejects(
      acquireProfile("page-race", { root, timeoutMs: 100 }),
      /timed out/,
    );
    assert.equal((await runtime.shutdown()).complete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("unexpected disconnect does not release ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-session-test-"));
  try {
    const context = new FakeContext();
    const runtime = make(root, async () => context);
    await runtime.start({ profile: "orphan" });
    context.browserObject.emit("disconnected");
    await assert.rejects(
      acquireProfile("orphan", { root, timeoutMs: 100 }),
      /timed out/,
    );
    assert.equal((await runtime.shutdown()).complete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
