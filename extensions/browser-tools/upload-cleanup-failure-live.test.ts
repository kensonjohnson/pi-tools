import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";

test(
  "failed pre-dispatch cleanup makes stop and later shutdown report recovery",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-cleanup-failure-"));
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let staged = "";
    const stage: any = async (
      _a: unknown,
      _b: unknown,
      _c: unknown,
      _d: unknown,
      _signal: AbortSignal,
      onRoot: (path: string) => void,
    ) => {
      staged = await mkdtemp(join(root, "staged-"));
      onRoot(staged);
      started();
      await gate;
      throw Object.assign(new Error("simulated cleanup failure"), {
        uploadCleanupFailed: true,
      });
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
        .catch(() => {});
      await entered;
      const stopped = sessions.stop(target.sessionId, 5000, undefined, "owner");
      release();
      await assert.rejects(stopped, (error: Error) =>
        error.message.includes(staged),
      );
      await upload;
      const shutdown = await sessions.shutdown(5000, "owner");
      assert.equal(shutdown.complete, false);
      assert.equal(
        shutdown.uploadRecovery?.entries[0].status,
        "cleanup_failed",
      );
      assert.equal(shutdown.uploadRecovery?.entries[0].path, staged);
    } finally {
      release();
      await sessions.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
);
