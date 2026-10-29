import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ManagedSessions } from "./sessions.ts";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Page extends EventEmitter {
  closed = false;
  isClosed() {
    return this.closed;
  }
  url() {
    return "about:blank";
  }
  async close() {
    this.closed = true;
    this.emit("close");
  }
}
class Browser extends EventEmitter {
  connected = true;
  isConnected() {
    return this.connected;
  }
}
class Context {
  page = new Page();
  browserHandle = new Browser();
  gate?: Promise<void>;
  browser() {
    return this.browserHandle;
  }
  pages() {
    return [this.page];
  }
  async close() {
    await this.gate;
    await this.page.close();
    this.browserHandle.connected = false;
    this.browserHandle.emit("disconnected");
  }
}

test("interrupted old-browser close quarantines the profile and never dispatches a replacement", async () => {
  const gate = deferred(),
    context = new Context();
  context.gate = gate.promise;
  let launches = 0,
    releases = 0,
    abandons = 0;
  const lease = {
    path: "/private/fake",
    release: async () => {
      releases++;
    },
    abandon: () => {
      abandons++;
    },
  };
  const sessions = new ManagedSessions({
    launch: async () => {
      throw new Error("unexpected");
    },
    acquireProfile: async () => lease as never,
    launchPersistent: async () => {
      launches++;
      return context as never;
    },
  });
  try {
    const target = await sessions.start({
      profile: "test",
      headless: true,
      artifactOwner: "owner",
    });
    const request: any = sessions.requestVisibleRestart(target, "owner");
    const abort = new AbortController();
    const restart = sessions.confirmVisibleRestart(
      target.sessionId,
      request.restartId,
      "owner",
      abort.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await assert.rejects(restart, /ownership may be quarantined/);
    assert.equal(launches, 1);
    assert.equal(releases, 0);
    assert.equal(abandons, 1);
    assert.equal(
      (sessions.handoffStatus(target.sessionId, "owner") as any).status,
      "failed",
    );
    await assert.rejects(
      sessions.content(target, undefined, "owner"),
      /Session unavailable/,
    );
    gate.resolve();
  } finally {
    gate.resolve();
    await sessions.shutdown();
  }
});

test("active downloads prevent a restart request without cancellation or close", async () => {
  const context = new Context();
  let released = 0;
  const lease = {
    path: "/private/fake",
    release: async () => {
      released++;
    },
    abandon: () => {},
  };
  const downloads = {
    attach: () => {},
    detach: () => {},
    list: () => [{ state: "saving" }],
    endSession: async () => ({ cleanup: "complete" }),
  };
  const sessions = new ManagedSessions({
    launch: async () => {
      throw new Error("unexpected");
    },
    acquireProfile: async () => lease as never,
    launchPersistent: async () => context as never,
    downloads: downloads as never,
  });
  try {
    const target = await sessions.start({
      profile: "test",
      headless: true,
      artifactOwner: "owner",
    });
    assert.throws(
      () => sessions.requestVisibleRestart(target, "owner"),
      /download is still active/,
    );
    assert.equal(context.page.closed, false);
    assert.equal(released, 0);
    assert.equal(
      sessions.handoffStatus(target.sessionId, "owner").status,
      "active",
    );
  } finally {
    await sessions.shutdown();
  }
});

test("visible launch failure quarantines retained ownership and leaves old IDs invalid", async () => {
  const context = new Context();
  let launches = 0,
    releases = 0,
    abandons = 0;
  const lease = {
    path: "/private/fake",
    release: async () => {
      releases++;
    },
    abandon: () => {
      abandons++;
    },
  };
  const sessions = new ManagedSessions({
    launch: async () => {
      throw new Error("unexpected");
    },
    acquireProfile: async () => lease as never,
    launchPersistent: async () => {
      if (++launches === 2) throw new Error("launch failed");
      return context as never;
    },
  });
  try {
    const target = await sessions.start({
      profile: "test",
      headless: true,
      artifactOwner: "owner",
    });
    const request: any = sessions.requestVisibleRestart(target, "owner");
    await assert.rejects(
      sessions.confirmVisibleRestart(
        target.sessionId,
        request.restartId,
        "owner",
      ),
      /ownership may be quarantined/,
    );
    assert.equal(launches, 2);
    assert.equal(releases, 0);
    assert.ok(abandons >= 1);
    assert.equal(
      (sessions.handoffStatus(target.sessionId, "owner") as any).status,
      "failed",
    );
    assert.throws(
      () => sessions.handoffStatus(target.sessionId, "foreign"),
      /Session unavailable/,
    );
  } finally {
    await sessions.shutdown();
  }
});
