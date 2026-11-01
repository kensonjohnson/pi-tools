import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { ArtifactStore } from "./artifacts.ts";
import { DownloadManager } from "./downloads.ts";
import { ManagedSessions } from "./sessions.ts";

test(
  "owned Chromium retains native download after quota failure for explicit export",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "native-download-live-")),
    );
    const server = createServer((req, res) => {
      if (req.url === "/") {
        res.setHeader("content-type", "text/html");
        res.end('<a id="download" href="/file">download</a>');
      } else {
        res.setHeader(
          "content-disposition",
          'attachment; filename="fixture.txt"',
        );
        res.end("native recovery bytes");
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const manager = new DownloadManager({
      sink: new ArtifactStore({ root: join(root, "store"), quota: 2 }),
    });
    let browser: Browser | undefined;
    const sessions = new ManagedSessions({
      launch: async ({ headless }) =>
        (browser = await chromium.launch({ headless })),
      downloads: manager,
    });
    try {
      const target = await sessions.start({
        headless: true,
        artifactOwner: "owner",
      });
      await sessions.navigate(
        `http://127.0.0.1:${address.port}/`,
        target,
        undefined,
        30000,
        "owner",
      );
      const page = browser!.contexts()[0].pages()[0];
      const event = page.waitForEvent("download");
      await page.click("#download");
      await event;
      const id = manager.list(target.sessionId)[0].id;
      const failed = await manager.wait(target.sessionId, id);
      assert.equal(failed.state, "failed");
      assert.equal(failed.nativeRecovery, "available_until_session_close");
      await assert.rejects(
        sessions.stop(target.sessionId, 5000, undefined, "owner"),
        /stop blocked/,
      );
      await assert.rejects(
        sessions.stop(target.sessionId, 5000, undefined, "other", true),
        /Session unavailable/,
      );
      const cancelled = new AbortController();
      cancelled.abort();
      await assert.rejects(
        sessions.stop(target.sessionId, 5000, cancelled.signal, "owner", true),
        /cancelled/,
      );
      assert.equal(
        manager.inspect(target.sessionId, id).nativeRecovery,
        "available_until_session_close",
      );
      const destination = join(root, "saved.txt");
      assert.equal(
        (await manager.exportNative(target.sessionId, id, destination)).status,
        "complete",
      );
      assert.equal(
        await readFile(destination, "utf8"),
        "native recovery bytes",
      );
      await sessions.stop(target.sessionId, 5000, undefined, "owner");
      assert.equal(
        manager.inspect(target.sessionId, id).nativeRecovery,
        "unknown_after_close",
      );
    } finally {
      await sessions.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
