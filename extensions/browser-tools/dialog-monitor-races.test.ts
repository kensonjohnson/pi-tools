import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ManagedSessions } from "./sessions.ts";

class CDP extends EventEmitter {
  detached = false;
  async send() {
    return {};
  }
  async detach() {
    this.detached = true;
    this.emit("Disconnected");
  }
}
class Page extends EventEmitter {
  closed = false;
  cdp = new CDP();
  isClosed() {
    return this.closed;
  }
  url() {
    return "about:blank";
  }
  mainFrame() {
    return this;
  }
  context() {
    return { newCDPSession: async () => this.cdp };
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
const modal = () => ({
  type: () => "confirm",
  message: () => "same",
  defaultValue: () => "",
  dismiss: async () => {},
  accept: async () => {},
});

test("monitor disconnect or frame mismatch leaves dialog state unknown and removes listeners on close", async () => {
  for (const failure of ["disconnect", "frame-mismatch"] as const) {
    const browser = new Browser();
    const sessions = new ManagedSessions({
      launch: async () => browser as never,
    });
    const target = await sessions.start({ artifactOwner: "owner" });
    browser.page.emit("dialog", modal());
    browser.page.cdp.emit("Page.javascriptDialogOpening", {
      frameId: "one",
      type: "confirm",
      message: "same",
    });
    if (failure === "disconnect") browser.page.cdp.emit("Disconnected");
    browser.page.cdp.emit("Page.javascriptDialogClosed", {
      frameId: failure === "disconnect" ? "one" : "other",
      result: false,
    });
    const status = await sessions.dialog(target, "owner", {
      action: "refresh",
    });
    assert.equal(status.status, "unknown");
    await assert.rejects(
      sessions.evaluate("1", target, undefined, "owner"),
      /dialog is pending/,
    );
    await sessions.stop(target.sessionId, 1000, undefined, "owner");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(browser.page.cdp.detached, true);
    assert.equal(browser.page.listenerCount("frameattached"), 0);
    await sessions.shutdown();
  }
});
