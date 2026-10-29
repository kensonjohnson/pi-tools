import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { chromium, type Browser } from "playwright";
import { ManagedSessions } from "./sessions.ts";

test(
  "external beforeunload dismissal settles a pending close without closing the tab",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    let browser!: Browser;
    const sessions = new ManagedSessions({
      launch: async ({ headless }) => {
        browser = await chromium.launch({ headless });
        return browser;
      },
    });
    try {
      const target = await sessions.start({
        headless: true,
        artifactOwner: "owner",
      });
      await sessions.navigate(
        "data:text/html,<button>Activate</button>",
        target,
        undefined,
        30000,
        "owner",
      );
      await sessions.action(target, "owner", {
        action: "click",
        target: { selector: "button" },
      });
      await sessions.evaluate(
        "(() => { window.onbeforeunload = e => { e.preventDefault(); e.returnValue = 'leave'; }; })()",
        target,
        undefined,
        "owner",
      );
      const page = browser.contexts()[0].pages()[0];
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.enable");
      const pending: any = await sessions.closeTab(target, undefined, "owner");
      assert.equal(pending.dialog.type, "beforeunload");
      await cdp.send("Page.handleJavaScriptDialog", { accept: false });
      let status: any;
      for (let i = 0; i < 200; i++) {
        status = await sessions.dialog(target, "owner", {
          action: "operation",
          operationId: pending.operationId,
        });
        if (status.status === "settled") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(status.result.closed, false);
      assert.equal(page.isClosed(), false);
      await cdp.detach();
    } finally {
      await sessions.shutdown();
    }
  },
);

test(
  "prearmed page monitor reconciles an OOPIF dialog dismissal",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(
        request.url === "/"
          ? `<iframe id="child" src="http://localhost:${(server.address() as any).port}/child"></iframe>`
          : `<button onclick="confirm('child')">Child</button>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    let browser!: Browser;
    const sessions = new ManagedSessions({
      launch: async ({ headless }) => {
        browser = await chromium.launch({
          headless,
          args: ["--site-per-process"],
        });
        return browser;
      },
    });
    try {
      const target = await sessions.start({
        headless: true,
        artifactOwner: "owner",
      });
      await sessions.navigate(
        `http://127.0.0.1:${(server.address() as any).port}/`,
        target,
        undefined,
        30000,
        "owner",
      );
      const page = browser.contexts()[0].pages()[0];
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.enable");
      const pending: any = await sessions.action(target, "owner", {
        action: "click",
        target: { frameSelector: "#child", selector: "button" },
      });
      assert.equal(pending.status, "awaiting_dialog");
      await cdp.send("Page.handleJavaScriptDialog", { accept: false });
      let status: any;
      for (let i = 0; i < 200; i++) {
        status = await sessions.dialog(target, "owner", { action: "refresh" });
        if (status.status === "none") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(status.status, "none");
      await cdp.detach();
    } finally {
      await sessions.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "prearmed monitor handles consecutive identical externally dismissed dialogs without replay",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    let browser!: Browser;
    const sessions = new ManagedSessions({
      launch: async ({ headless }) => {
        browser = await chromium.launch({ headless });
        return browser;
      },
    });
    try {
      const target = await sessions.start({
        headless: true,
        artifactOwner: "owner",
      });
      const page = browser.contexts()[0].pages()[0];
      const control = await page.context().newCDPSession(page);
      await control.send("Page.enable");
      for (let attempt = 0; attempt < 3; attempt++) {
        const pending: any = await sessions.evaluate(
          "(() => { confirm('same'); confirm('same'); return 'done'; })()",
          target,
          undefined,
          "owner",
        );
        assert.equal(pending.status, "awaiting_dialog");
        await assert.rejects(
          sessions.evaluate("1", target, undefined, "owner"),
          /dialog is pending|Session is busy/,
        );
        await control.send("Page.handleJavaScriptDialog", { accept: false });
        let second: any;
        for (let i = 0; i < 200; i++) {
          second = await sessions.dialog(target, "owner", {
            action: "inspect",
          });
          if (
            second.status === "awaiting_dialog" &&
            second.id !== pending.dialog.id
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(second.status, "awaiting_dialog");
        assert.notEqual(second.id, pending.dialog.id);
        await control.send("Page.handleJavaScriptDialog", { accept: false });
        let operation: any;
        for (let i = 0; i < 200; i++) {
          operation = await sessions.dialog(target, "owner", {
            action: "operation",
            operationId: pending.operationId,
          });
          if (
            operation.status === "settled" &&
            (await sessions.dialog(target, "owner", { action: "refresh" }))
              .status === "none"
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(operation.status, "settled");
        assert.equal(operation.result.text, "done");
        assert.equal(
          (await sessions.dialog(target, "owner", { action: "refresh" }))
            .status,
          "none",
        );
      }
      await control.detach();
    } finally {
      await sessions.shutdown();
    }
  },
);
