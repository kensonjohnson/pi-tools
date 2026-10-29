import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ManagedSessions } from "./sessions.ts";

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
  page = new Page();
  async newContext() {
    return { newPage: async () => this.page };
  }
  async close() {
    await this.page.close();
    this.emit("disconnected");
  }
}

test("pending dialog blocks other work and aborting a response quarantines without retry", async () => {
  const browser = new Browser();
  const sessions = new ManagedSessions({
    launch: async () => browser as never,
  });
  const target = await sessions.start({ artifactOwner: "owner" });
  let accepts = 0,
    dismisses = 0;
  browser.page.emit("dialog", {
    type: () => "prompt",
    message: () => "x".repeat(2000),
    defaultValue: () => "default",
    accept: async () => {
      accepts++;
      await new Promise(() => {});
    },
    dismiss: async () => {
      dismisses++;
    },
  });
  const pending: any = await sessions.dialog(target, "owner", {
    action: "inspect",
  });
  assert.equal(pending.message.length, 1000);
  await assert.rejects(
    sessions.dialog(target, "foreign", { action: "accept", id: pending.id }),
    /Session unavailable/,
  );
  await assert.rejects(
    sessions.action(target, "owner", {
      action: "click",
      target: { selector: "button" },
    }),
    /dialog is pending/,
  );
  const abort = new AbortController();
  const resolution = sessions.dialog(
    target,
    "owner",
    { action: "accept", id: pending.id, promptText: "answer" },
    abort.signal,
  );
  await assert.rejects(
    sessions.dialog(target, "owner", { action: "dismiss", id: pending.id }),
    /already in progress/,
  );
  abort.abort();
  await assert.rejects(resolution, /response may have occurred/);
  assert.equal(accepts, 1);
  assert.equal(dismisses, 0);
  await assert.rejects(
    sessions.dialog(target, "owner", { action: "inspect" }),
    /Session unavailable/,
  );
  await sessions.shutdown();
});
