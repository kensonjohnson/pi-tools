import { test } from "node:test";
import assert from "node:assert/strict";
import type { Browser } from "playwright";
import { launchFixtureBrowser } from "./download-test-helper.ts";
import { ManagedSessions } from "../../extensions/browser-tools/sessions.ts";
import { DownloadManager } from "../../extensions/browser-tools/downloads.ts";
import { BrowserDiagnostics } from "../../extensions/browser-tools/diagnostics.ts";

test(
  "page capacity rejection closes the new Chromium tab and retains the original",
  { timeout: 30000 },
  async () => {
    let browser: Browser | undefined;
    let fixture: Awaited<ReturnType<typeof launchFixtureBrowser>> | undefined;
    const downloads = new DownloadManager({
      sink: {
        async putBinary() {
          throw new Error("unexpected");
        },
      },
      maxPages: 1,
    });
    const diagnostics = new BrowserDiagnostics();
    const sessions = new ManagedSessions({
      launch: async ({ headless }) => {
        fixture = await launchFixtureBrowser(headless);
        return (browser = fixture.browser);
      },
      diagnostics,
      downloads,
      downloadCloseTimeoutMs: 2000,
    });
    try {
      const first = await sessions.start({
        headless: process.env.BROWSER_HEADED !== "1",
      });
      const context = browser!.contexts()[0];
      assert.equal(context.pages().length, 1);
      await assert.rejects(sessions.newTab(first.sessionId), /page capacity/);
      assert.equal(context.pages().length, 1);
      assert.equal(context.pages()[0].isClosed(), false);
      assert.equal(sessions.list()[0].tabs.length, 1);
      await sessions.navigate("data:text/html,<p>original</p>", first);
      assert.match((await sessions.content(first)).html, /original/);
    } finally {
      try {
        await sessions.shutdown(5000);
      } finally {
        await fixture?.close();
      }
    }
  },
);
