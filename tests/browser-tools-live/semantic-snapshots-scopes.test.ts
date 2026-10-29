import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { SemanticSnapshots } from "../../extensions/browser-tools/semantic-snapshots.ts";

test(
  "simple exact ID scopes work on large pages and report unchecked duplicates",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<section id="important"><h2>First target</h2><button>Run</button></section><section id="important"><h2>Second target</h2></section><div>${"<i></i>".repeat(21000)}</div>`,
      );
      const snapshots = new SemanticSnapshots(page);
      const result = await snapshots.snapshot({ selector: "#important" });
      assert(result.records.some((r) => r.name === "First target"));
      assert(!result.records.some((r) => r.name === "Second target"));
      assert(
        result.omitted.some((x) =>
          /first match.*duplicate IDs are not checked/.test(x),
        ),
      );
      const ref = result.records.find((r) => r.name === "Run")?.ref;
      assert(ref);
      assert(await snapshots.resolve(ref));
      await assert.rejects(
        snapshots.snapshot({ selector: "section#important" }),
        /Scope resolution node limit/,
      );
      await snapshots.dispose();
    } finally {
      await browser.close();
    }
  },
);
