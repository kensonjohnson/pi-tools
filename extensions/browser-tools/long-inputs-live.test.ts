import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";

test(
  "long selectors and longer action deadlines reach Playwright",
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
      const id = "a".repeat(1100);
      await sessions.withOwnedPage(target, undefined, "owner", (page) =>
        page.setContent(`<button id="${id}">Go</button>`),
      );
      const snapshot = await sessions.snapshot(target, "owner", undefined, {
        selector: `#${id}`,
      });
      const ref = snapshot.snapshot.records.find(
        (record) => record.role === "button",
      )?.ref;
      assert.ok(ref);
      const clicked = await sessions.clickSnapshotRef(
        target,
        "owner",
        ref,
        undefined,
        30001,
      );
      assert.equal((clicked as any).status, "completed");
      const action = await sessions.action(target, "owner", {
        action: "click",
        target: { selector: `#${id}` },
        timeoutMs: 30001,
      });
      assert.equal((action as any).status, "completed");
    } finally {
      await sessions.shutdown();
    }
  },
);
