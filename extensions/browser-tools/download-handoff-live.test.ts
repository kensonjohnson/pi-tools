import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { DownloadManager } from "./downloads.ts";
import { ManagedSessions } from "./sessions.ts";

test(
  "headed handoff ignores human downloads without cancelling them and stays fail-closed after confirmation",
  {
    skip:
      process.env.BROWSER_HEADED !== "1" ||
      !existsSync(chromium.executablePath()),
    timeout: 30000,
  },
  async () => {
    let releasePrior!: () => void;
    const priorGate = new Promise<void>((resolve) => {
      releasePrior = resolve;
    });
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response.setHeader("content-type", "text/html");
        response.end(
          `<a id="prior" href="/prior">Prior</a><a id="human" href="/human">Human</a><a id="after" href="/after">After</a>`,
        );
        return;
      }
      response.setHeader("content-type", "application/octet-stream");
      response.setHeader(
        "content-disposition",
        `attachment; filename="file.bin"`,
      );
      if (request.url === "/prior") {
        response.end("prior-bytes");
        return;
      }
      response.end(request.url === "/human" ? "human-private" : "after-bytes");
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
          if (text === "prior-bytes") await priorGate;
          captured.push(text);
          return {
            id: `artifact-${captured.length}`,
            path: "/private",
            bytes: Buffer.byteLength(text),
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
      const page = browser.contexts()[0].pages()[0];
      const started = page.waitForEvent("download", { timeout: 3000 });
      await page.evaluate(() =>
        (document.querySelector("#prior") as HTMLAnchorElement).click(),
      );
      await started;
      const priorId = downloads.list(target.sessionId)[0].id;
      const handoff = await sessions.beginHandoff(target, "owner");
      assert.equal(handoff.priorDownloads?.inFlightBefore, 1);
      assert.match(handoff.note, /browser-managed temporary storage/);
      assert.match(handoff.note, /stays suspended after confirmation/);
      const humanStart = page.waitForEvent("download");
      await page.locator("#human").click();
      const human = await humanStart;
      assert.equal(await human.failure(), null);
      const stream = await human.createReadStream();
      assert.ok(stream);
      let humanBytes = "";
      for await (const chunk of stream)
        humanBytes += Buffer.from(chunk).toString();
      assert.equal(humanBytes, "human-private");
      assert.equal(downloads.list(target.sessionId).length, 1);
      assert.deepEqual(captured, []);
      releasePrior();
      assert.equal(
        (await downloads.wait(target.sessionId, priorId)).state,
        "complete",
      );
      assert.deepEqual(captured, ["prior-bytes"]);
      const resumed = sessions.confirmHandoff(
        target.sessionId,
        handoff.handoffId!,
        "owner",
      );
      assert.deepEqual(resumed.downloadGap, {
        ignored: 1,
        inFlightBefore: 1,
        captureRestored: false,
      });
      const afterStart = page.waitForEvent("download");
      await page.locator("#after").click();
      const after = await afterStart;
      assert.equal(await after.failure(), null);
      assert.equal(downloads.list(target.sessionId).length, 1);
      assert.deepEqual(captured, ["prior-bytes"]);
    } finally {
      await sessions.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
