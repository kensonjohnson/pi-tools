import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { access, mkdtemp, open, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";

test(
  "large staged uploads reach a local HTTP server",
  {
    skip:
      !existsSync(chromium.executablePath()) ||
      !process.env.PI_BROWSER_LARGE_UPLOAD_TEST,
    timeout: 600000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-large-upload-test-"));
    let received = 0;
    let receivedHash = "";
    const stagingPaths: string[] = [];
    const server = createServer((req, res) => {
      if (req.method === "POST") {
        received = 0;
        const hash = createHash("sha256");
        req.on("data", (chunk: Buffer) => {
          received += chunk.length;
          hash.update(chunk);
        });
        req.on("end", () => {
          receivedHash = hash.digest("hex");
          res.end("ok");
        });
      } else {
        res.setHeader("content-type", "text/html");
        res.end('<input id="file" type="file">');
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const sessions = new ManagedSessions({
      launch: ({ headless }) => chromium.launch({ headless }),
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
      for (const size of [17 * 1024 * 1024, 1024 * 1024 * 1024]) {
        const file = await open(join(root, "fixture.bin"), "w");
        let expectedHash: string | undefined;
        if (size === 17 * 1024 * 1024) {
          const chunk = Buffer.alloc(1024 * 1024);
          for (let i = 0; i < chunk.length; i++)
            chunk[i] = (i * 17 + (i >>> 8) + 13) & 255;
          const hash = createHash("sha256");
          for (let i = 0; i < 17; i++) {
            await file.writeFile(chunk);
            hash.update(chunk);
          }
          expectedHash = hash.digest("hex");
        } else await file.truncate(size);
        await file.close();
        const capture = await sessions.snapshot(target, "owner", undefined, {
          selector: "#file",
        });
        const ref = capture.snapshot.records.find((record) => record.ref)?.ref;
        assert.ok(ref);
        const result: any = await sessions.upload(target, "owner", {
          ref,
          paths: ["fixture.bin"],
          cwd: root,
          maxFileBytes: Number.MAX_SAFE_INTEGER,
          maxTotalBytes: Number.MAX_SAFE_INTEGER,
          timeoutMs: 300000,
        });
        assert.equal(result.status, "completed");
        stagingPaths.push(result.staging.path);
        assert.equal(result.bytes, size);
        const sent = await sessions.evaluate(
          "fetch('/', {method:'POST', body: document.querySelector('#file').files[0]}).then(r => r.text())",
          target,
          undefined,
          "owner",
        );
        assert.equal(sent.text, "ok");
        assert.equal(received, size);
        if (expectedHash) assert.equal(receivedHash, expectedHash);
      }
    } finally {
      await sessions.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
      for (const path of stagingPaths)
        await assert.rejects(access(path), { code: "ENOENT" });
    }
  },
);
