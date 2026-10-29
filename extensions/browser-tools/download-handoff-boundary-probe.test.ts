import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { DownloadManager } from "./downloads.ts";
import { ManagedSessions } from "./sessions.ts";

test(
  "probe a human download whose event arrives after confirmation",
  {
    skip:
      process.env.BROWSER_HEADED !== "1" ||
      !existsSync(chromium.executablePath()),
    timeout: 30000,
  },
  async () => {
    let requestArrived!: () => void, release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      requestArrived = resolve;
    });
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response.setHeader("content-type", "text/html");
        response.end(`<a id="human" href="/human">Download</a>`);
        return;
      }
      if (request.url === "/human") {
        requestArrived();
        release = () => {
          response.setHeader(
            "content-disposition",
            "attachment; filename=human.txt",
          );
          response.end("human-private");
        };
        return;
      }
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const captured: string[] = [];
    const downloads = new DownloadManager({
      sink: {
        putBinary: async (_owner, stream) => {
          let text = "";
          for await (const chunk of stream)
            text += Buffer.from(chunk).toString();
          captured.push(text);
          return {
            id: "artifact",
            path: "/private",
            bytes: text.length,
            expiresAt: 1,
          };
        },
      },
    });
    let browser!: Browser;
    const sessions = new ManagedSessions({
      launch: async ({ headless }) => {
        browser = await chromium.launch({ headless });
        return browser;
      },
      downloads,
    });
    try {
      const target = await sessions.start({
        artifactOwner: "owner",
        headless: false,
      });
      await sessions.navigate(
        `http://127.0.0.1:${(server.address() as any).port}/`,
        target,
        undefined,
        30000,
        "owner",
      );
      const handoff = await sessions.beginHandoff(target, "owner");
      const page = browser.contexts()[0].pages()[0];
      await page.evaluate(() =>
        (document.querySelector("#human") as HTMLAnchorElement).click(),
      );
      await arrived;
      sessions.confirmHandoff(target.sessionId, handoff.handoffId!, "owner");
      const download = page.waitForEvent("download", { timeout: 5000 });
      release();
      const human = await download;
      assert.equal(await human.failure(), null);
      assert.deepEqual(downloads.list(target.sessionId), []);
      assert.deepEqual(captured, []);
    } finally {
      await sessions.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
