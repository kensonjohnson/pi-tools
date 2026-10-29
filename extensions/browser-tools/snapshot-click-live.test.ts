import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";

test(
  "snapshot clicks use retained identity and fail closed on stale, foreign, disabled and cancelled targets",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const sessions = new ManagedSessions({
      launch: ({ headless }) => chromium.launch({ headless }),
    });
    try {
      const target = await sessions.start({
        headless: true,
        artifactOwner: "owner",
      });
      await sessions.navigate(
        "data:text/html,<button id='b' onclick='window.count=(window.count||0)+1'>Choose</button>",
        target,
        undefined,
        30000,
        "owner",
      );
      const snapshotRef = async () => {
        const result = await sessions.snapshot(target, "owner");
        const ref = result.snapshot.records.find((record) => record.ref)?.ref;
        assert.ok(ref);
        return ref;
      };
      const evalPage = (code: string) =>
        sessions.evaluate(code, target, undefined, "owner");
      let ref = await snapshotRef();
      await assert.rejects(
        sessions.clickSnapshotRef(target, "foreign", ref),
        /Session unavailable/,
      );
      await sessions.clickSnapshotRef(target, "owner", ref);
      assert.equal((await evalPage("window.count")).text, "1");
      ref = await snapshotRef();
      await evalPage(
        "(() => { const b = document.querySelector('button'); b.replaceWith(b.cloneNode(true)); })()",
      );
      await assert.rejects(
        sessions.clickSnapshotRef(target, "owner", ref),
        /Stale reference/,
      );
      assert.equal((await evalPage("window.count")).text, "1");
      ref = await snapshotRef();
      await sessions.navigate(
        "data:text/html,<button disabled>Wait</button>",
        target,
        undefined,
        30000,
        "owner",
      );
      await assert.rejects(
        sessions.clickSnapshotRef(target, "owner", ref),
        /Stale reference/,
      );
      ref = await snapshotRef();
      await assert.rejects(
        sessions.clickSnapshotRef(target, "owner", ref, undefined, 100),
        /dispatch may have started/,
      );
      const abort = new AbortController();
      const pending = sessions.clickSnapshotRef(
        target,
        "owner",
        ref,
        abort.signal,
        5000,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      abort.abort();
      await assert.rejects(
        pending,
        /already dispatched action may have occurred/,
      );
      await assert.rejects(
        sessions.clickSnapshotRef(target, "owner", ref),
        /Session unavailable/,
      );
    } finally {
      await sessions.shutdown();
    }
  },
);
