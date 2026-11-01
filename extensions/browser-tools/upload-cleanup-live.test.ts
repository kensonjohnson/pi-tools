import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";
import { stageUploadFiles } from "./upload-files.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test(
  "pre-dispatch chooser failure and browser closure during copy remove staging",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const originalTmp = process.env.TMPDIR;
    const root = await mkdtemp(join(tmpdir(), "upload-cleanup-test-"));
    process.env.TMPDIR = root;
    const sessions = new ManagedSessions({
      launch: ({ headless }) => chromium.launch({ headless }),
    });
    const staging = async () =>
      (await readdir(root)).filter((name) =>
        name.startsWith("pi-browser-upload-"),
      );
    try {
      await writeFile(join(root, "small.txt"), "abc");
      const target = await sessions.start({
        headless: true,
        artifactOwner: "owner",
      });
      await sessions.navigate(
        `data:text/html,${encodeURIComponent('<button id="noop">No chooser</button><input id="file" type="file">')}`,
        target,
        undefined,
        30000,
        "owner",
      );
      const failed: any = await sessions
        .upload(target, "owner", {
          mode: "chooser",
          selector: "#noop",
          paths: ["small.txt"],
          cwd: root,
          maxFileBytes: Number.MAX_SAFE_INTEGER,
          maxTotalBytes: Number.MAX_SAFE_INTEGER,
          timeoutMs: 300,
        })
        .catch((error) => error);
      assert.notEqual(failed.status, "completed");
      assert.deepEqual(await staging(), []);
      // Chooser failure closes the session. Use a new one for the copy race.
      const second = await sessions.start({
        headless: true,
        artifactOwner: "owner",
      });
      await sessions.navigate(
        `data:text/html,${encodeURIComponent('<input id="file" type="file">')}`,
        second,
        undefined,
        30000,
        "owner",
      );
      const capture = await sessions.snapshot(second, "owner", undefined, {
        selector: "#file",
      });
      const ref = capture.snapshot.records.find((record) => record.ref)?.ref;
      assert.ok(ref);
      const file = await open(join(root, "large.bin"), "w");
      await file.truncate(1024 * 1024 * 1024);
      await file.close();
      const controller = new AbortController();
      const copying = stageUploadFiles(
        ["large.bin"],
        root,
        {
          maxFileBytes: Number.MAX_SAFE_INTEGER,
          maxTotalBytes: Number.MAX_SAFE_INTEGER,
        },
        Date.now() + 300000,
        controller.signal,
      ).catch((error) => error);
      for (let i = 0; i < 1000 && !(await staging()).length; i++)
        await sleep(1);
      assert.equal((await staging()).length, 1);
      controller.abort();
      assert.match(String(await copying), /cancelled/);
      assert.deepEqual(await staging(), []);
      const upload = sessions
        .upload(second, "owner", {
          ref,
          paths: ["large.bin"],
          cwd: root,
          maxFileBytes: Number.MAX_SAFE_INTEGER,
          maxTotalBytes: Number.MAX_SAFE_INTEGER,
          timeoutMs: 300000,
        })
        .catch((error) => error);
      for (let i = 0; i < 1000 && !(await staging()).length; i++)
        await sleep(1);
      assert.equal((await staging()).length, 1);
      await sessions.stop(second.sessionId, 5000, undefined, "owner");
      await upload;
      for (let i = 0; i < 1000 && (await staging()).length; i++) await sleep(1);
      assert.deepEqual(await staging(), []);
    } finally {
      await sessions.shutdown();
      if (originalTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmp;
      await rm(root, { recursive: true, force: true });
    }
  },
);
