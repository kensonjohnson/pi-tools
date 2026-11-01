import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";

test(
  "unverified close retains dispatched staging and reports its recovery path",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-retention-test-"));
    const browser = await chromium.launch({ headless: true });
    const close = browser.close.bind(browser);
    browser.close = async () => {
      throw new Error("simulated close failure");
    };
    const sessions = new ManagedSessions({ launch: async () => browser });
    let stagingPath = "";
    try {
      await writeFile(join(root, "file.txt"), "retained");
      const target = await sessions.start({
        headless: true,
        artifactOwner: "owner",
      });
      await sessions.navigate(
        `data:text/html,${encodeURIComponent('<input id="file" type="file">')}`,
        target,
        undefined,
        30000,
        "owner",
      );
      const capture = await sessions.snapshot(target, "owner", undefined, {
        selector: "#file",
      });
      const ref = capture.snapshot.records.find((record) => record.ref)?.ref;
      assert.ok(ref);
      const result: any = await sessions.upload(target, "owner", {
        ref,
        paths: ["file.txt"],
        cwd: root,
        maxFileBytes: Number.MAX_SAFE_INTEGER,
        maxTotalBytes: Number.MAX_SAFE_INTEGER,
        timeoutMs: 5000,
      });
      assert.equal(result.status, "completed");
      assert.equal(result.staging.status, "retained_until_browser_close");
      stagingPath = result.staging.path;
      assert.equal(
        await readFile(join(stagingPath, "0", "file.txt"), "utf8"),
        "retained",
      );
      await assert.rejects(
        sessions.stop(target.sessionId, 5000, undefined, "owner"),
        (error: Error) => error.message.includes(stagingPath),
      );
      await access(stagingPath);
    } finally {
      await close();
      await sessions.shutdown();
      if (stagingPath) await rm(stagingPath, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
);
