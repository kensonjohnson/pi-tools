import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";

test(
  "stop resolves only after a pre-dispatch copy has cleaned up",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-stop-wait-"));
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stage: any = async (
      _a: unknown,
      _b: unknown,
      _c: unknown,
      _d: unknown,
      _signal: AbortSignal,
      onRoot: (path: string) => void,
    ) => {
      const path = await mkdtemp(join(root, "staged-"));
      onRoot(path);
      started();
      await gate;
      await rm(path, { recursive: true, force: true });
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
        .catch(() => {});
      await entered;
      let settled = false;
      const stop = sessions
        .stop(target.sessionId, 5000, undefined, "owner")
        .then(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(settled, false);
      release();
      await stop;
      await upload;
      assert.equal(settled, true);
      assert.deepEqual(sessions.uploadRecovery("owner").entries, []);
    } finally {
      release();
      await sessions.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
);
