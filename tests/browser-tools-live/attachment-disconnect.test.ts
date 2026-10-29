import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discoverAttachmentEndpoint } from "../../extensions/browser-tools/attachment-endpoint.ts";
import { connectAttachment } from "../../extensions/browser-tools/attachment-transport.ts";
import { AttachmentLeases } from "../../extensions/browser-tools/attachment-leases.ts";

test(
  "CDP client close disconnects without closing disposable Chromium or its pages",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "attachment-fixture-"));
    const child = spawn(
      chromium.executablePath(),
      [
        "--headless",
        "--no-sandbox",
        "--no-first-run",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${dir}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        let text = "";
        child.once("error", reject);
        child.once("exit", () => reject(new Error("fixture exited")));
        child.stderr.on("data", (chunk) => {
          text += chunk.toString();
          const match =
            /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(
              text,
            );
          if (match) resolve(match[1]);
        });
      });
      const url = new URL(endpoint);
      assert.equal(
        await discoverAttachmentEndpoint(`http://${url.host}`),
        endpoint,
      );
      const independent = await chromium.connectOverCDP(endpoint);
      const page = independent.contexts()[0].pages()[0];
      await page.goto("data:text/html,<title>fixture</title>");
      const unrelated = await independent.contexts()[0].newPage();
      await unrelated.goto("data:text/html,<title>unrelated</title>");
      const cdp = await independent.contexts()[0].newCDPSession(page);
      const id = (await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
      await cdp.detach();
      const connection = await connectAttachment(`http://${url.host}`);
      const leases = new AttachmentLeases(connection, `http://${url.host}`, {
        lockRoot: `${dir}-locks`,
      });
      const targets = await leases.targets("owner");
      assert.equal(targets.length, 2);
      assert.ok(targets.includes(id));
      await leases.select("owner", id);
      assert.equal(
        await leases.withPage("owner", (page) => page.title()),
        "fixture",
      );
      await assert.rejects(leases.withPage("other", (page) => page.title()));
      await leases.disconnect();
      assert.equal(await page.title(), "fixture");
      assert.equal(await unrelated.title(), "unrelated");
      const reconnected = await chromium.connectOverCDP(endpoint);
      assert.deepEqual(
        (
          await Promise.all(
            reconnected
              .contexts()[0]
              .pages()
              .map((page) => page.title()),
          )
        ).sort(),
        ["fixture", "unrelated"],
      );
      await reconnected.close();
      await independent.close();
      assert.equal(child.exitCode, null);
    } finally {
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
      await rm(dir, { recursive: true, force: true });
      await rm(`${dir}-locks`, { recursive: true, force: true });
    }
  },
);
