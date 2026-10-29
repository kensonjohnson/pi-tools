import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { connectAttachment } from "./attachment-transport.ts";

test(
  "browser-wide Playwright attachment dismisses an unselected tab's dialog",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "external-dialog-probe-")),
    );
    const child = spawn(
      chromium.executablePath(),
      [
        "--headless",
        "--no-sandbox",
        "--no-first-run",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${join(root, "profile")}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let independent:
      Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    let attachment: Awaited<ReturnType<typeof connectAttachment>> | undefined;
    try {
      const ws = await new Promise<string>((resolve, reject) => {
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
      const endpoint = `http://${new URL(ws).host}`;
      independent = await chromium.connectOverCDP(ws);
      const selected = independent.contexts()[0].pages()[0];
      const unrelated = await independent.contexts()[0].newPage();
      await unrelated.goto("data:text/html,<title>unrelated</title>");
      attachment = await connectAttachment(endpoint);
      let observed: import("playwright").Dialog | undefined;
      unrelated.once("dialog", (dialog) => {
        observed = dialog;
      });
      const result = unrelated.evaluate(() => confirm("Unrelated dialog"));
      for (let i = 0; i < 200 && !observed; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(observed);
      assert.equal(
        await Promise.race([
          result,
          new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), 1000),
          ),
        ]),
        false,
      );
      attachment.disconnect();
      assert.equal(await unrelated.title(), "unrelated");
      assert.equal(selected.isClosed(), false);
      assert.equal(child.exitCode, null);
    } finally {
      attachment?.disconnect();
      await independent?.close().catch(() => {});
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
      await rm(root, { recursive: true, force: true });
    }
  },
);
