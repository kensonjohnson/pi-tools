import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";

test(
  "snapshot scopes a unique main-document iframe and validates selectors",
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
      const html = `<button id="main">Main</button><iframe id="child" srcdoc="<button id='inside'>Child</button>"></iframe>`;
      await sessions.navigate(
        `data:text/html,${encodeURIComponent(html)}`,
        target,
        undefined,
        30000,
        "owner",
      );
      const child = await sessions.snapshot(target, "owner", undefined, {
        frameSelector: "#child",
        selector: "#inside",
      });
      assert.ok(
        child.snapshot.records.some(
          (record) => record.name === "Child" && record.ref,
        ),
      );
      assert.ok(
        !child.snapshot.records.some((record) => record.name === "Main"),
      );
      await assert.rejects(
        sessions.snapshot(target, "foreign", undefined, {
          frameSelector: "#child",
        }),
        /Session unavailable/,
      );
      await assert.rejects(
        sessions.snapshot(target, "owner", undefined, {
          frameSelector: "#main",
        }),
        /does not identify a frame/,
      );
      const main = await sessions.snapshot(target, "owner", undefined, {
        selector: "#main",
      });
      assert.ok(
        main.snapshot.omitted.some((notice) =>
          notice.includes("inspect a frame explicitly"),
        ),
      );
    } finally {
      await sessions.shutdown();
    }
  },
);
