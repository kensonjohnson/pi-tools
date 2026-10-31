import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { ArtifactStore } from "./artifacts.ts";
import { DownloadManager } from "./downloads.ts";
import { ManagedSessions } from "./sessions.ts";

const hashFile = async (path: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
test(
  "owned Chromium captures 17 MiB patterned and over-100 MiB sparse downloads",
  { skip: !existsSync(chromium.executablePath()), timeout: 180000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "browser-large-download-")),
    );
    const small = join(root, "pattern.bin"),
      large = join(root, "sparse.bin");
    const file = await open(small, "w");
    const pattern = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < pattern.length; i++)
      pattern[i] = (i * 17 + (i >>> 8) + 13) & 255;
    for (let i = 0; i < 17; i++) await file.writeFile(pattern);
    await file.close();
    const sparse = await open(large, "w");
    await sparse.truncate(101 * 1024 * 1024);
    await sparse.close();
    const server = createServer((req, res) => {
      if (req.url === "/") {
        res.setHeader("content-type", "text/html");
        res.end(
          '<a id="small" href="/small">small</a><a id="large" href="/large">large</a>',
        );
        return;
      }
      res.setHeader(
        "content-disposition",
        'attachment; filename="fixture.bin"',
      );
      createReadStream(req.url === "/small" ? small : large).pipe(res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const store = new ArtifactStore({ root: join(root, "store") });
    const downloads = new DownloadManager({ sink: store });
    let browser: Browser | undefined;
    const sessions = new ManagedSessions({
      launch: async ({ headless }) =>
        (browser = await chromium.launch({ headless })),
      downloads,
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
      const page: Page = browser!.contexts()[0].pages()[0];
      for (const [selector, path, size] of [
        ["#small", small, 17 * 1024 * 1024],
        ["#large", large, 101 * 1024 * 1024],
      ] as const) {
        const event = page.waitForEvent("download");
        await page.click(selector);
        await event;
        const record = downloads.list(target.sessionId).at(-1);
        assert.ok(record);
        const complete = await downloads.wait(target.sessionId, record.id, {
          timeoutMs: 300000,
        });
        assert.equal(complete.state, "complete", complete.failure);
        assert.equal(complete.artifact?.bytes, size);
        assert.equal(
          await hashFile(complete.artifact!.path),
          await hashFile(path),
        );
      }
    } finally {
      await sessions.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
