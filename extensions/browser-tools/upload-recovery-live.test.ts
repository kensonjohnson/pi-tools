import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test(
  "stop waits for preparation cleanup, and deadline reports pending owner-scoped recovery",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-wait-test-"));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stage: any = async (
      _paths: unknown,
      _cwd: unknown,
      _limits: unknown,
      _deadline: unknown,
      signal: AbortSignal,
      onRoot: (path: string) => void,
    ) => {
      const path = await mkdtemp(join(root, "staged-"));
      onRoot(path);
      started();
      await gate;
      await rm(path, { recursive: true, force: true });
      assert.ok(signal.aborted);
      throw new Error("cancelled");
    };
    const sessions = new ManagedSessions({
      launch: ({ headless }) => chromium.launch({ headless }),
      stageUpload: stage,
    });
    try {
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
      const upload = sessions
        .upload(target, "owner", {
          ref,
          paths: ["file"],
          cwd: root,
          maxFileBytes: Number.MAX_SAFE_INTEGER,
          maxTotalBytes: Number.MAX_SAFE_INTEGER,
          timeoutMs: 5000,
        })
        .catch((e) => e);
      await entered;
      assert.equal(sessions.uploadRecovery("other").entries.length, 0);
      const stop = sessions
        .stop(target.sessionId, 80, undefined, "owner")
        .catch((e) => e);
      const outcome = await stop;
      assert.match(String(outcome), /deadline exceeded/);
      assert.match(String(outcome), /preparing/);
      assert.equal(sessions.uploadRecovery("owner").pendingPreparations, 1);
      release();
      await upload;
      for (
        let i = 0;
        i < 100 && sessions.uploadRecovery("owner").pendingPreparations;
        i++
      )
        await sleep(5);
      assert.equal(sessions.uploadRecovery("owner").pendingPreparations, 0);
      assert.deepEqual(sessions.uploadRecovery("owner").entries, []);
      assert.equal((await sessions.shutdown(5000)).complete, true);
    } finally {
      release();
      await sessions.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "unsolicited disconnect retains and reports only the owner's staging through shutdown",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-disconnect-test-"));
    const browser = await chromium.launch({ headless: true });
    const close = browser.close.bind(browser);
    const sessions = new ManagedSessions({ launch: async () => browser });
    let path = "";
    try {
      await writeFile(join(root, "file.txt"), "data");
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
      path = result.staging.path;
      browser.emit("disconnected", browser);
      for (
        let i = 0;
        i < 100 &&
        sessions.uploadRecovery("owner").entries[0]?.status !==
          "closure_unknown";
        i++
      )
        await sleep(10);
      assert.deepEqual(sessions.uploadRecovery("owner").entries, [
        { path, sessionId: target.sessionId, status: "closure_unknown" },
      ]);
      assert.deepEqual(sessions.uploadRecovery("other").entries, []);
      const shutdown = await sessions.shutdown(5000, "owner");
      assert.equal(shutdown.complete, false);
      assert.equal(shutdown.uploadRecovery?.entries[0].path, path);
      assert.deepEqual(
        (await sessions.shutdown(5000, "other")).uploadRecovery?.entries,
        [],
      );
    } finally {
      await close().catch(() => {});
      await sessions.shutdown();
      if (path) await rm(path, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
);
