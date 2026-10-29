import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";

test(
  "managed live snapshots expire on navigation and reject foreign owners",
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
        "data:text/html,<button>Choose</button>",
        target,
        undefined,
        30000,
        "owner",
      );
      const result = await sessions.snapshot(target, "owner");
      const ref = result.snapshot.records.find((record) => record.ref)?.ref;
      assert.ok(ref);
      await sessions.validateSnapshotRef(target, "owner", ref);
      await assert.rejects(
        sessions.validateSnapshotRef(target, "foreign", ref),
        /Session unavailable/,
      );
      await assert.rejects(sessions.pick(target, "owner"), /visible/);
      await sessions.navigate(
        "data:text/html,<button>Other</button>",
        target,
        undefined,
        30000,
        "owner",
      );
      await assert.rejects(
        sessions.validateSnapshotRef(target, "owner", ref),
        /Stale reference/,
      );
    } finally {
      assert.equal((await sessions.shutdown()).complete, true);
    }
  },
);
