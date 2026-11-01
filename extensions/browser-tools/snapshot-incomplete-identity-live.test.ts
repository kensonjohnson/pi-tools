import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { SemanticSnapshots } from "./semantic-snapshots.ts";

test(
  "incomplete names never issue or retain actionable references",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const snapshots = new SemanticSnapshots(page);
    try {
      await page.setContent(`<button>${"<span>x</span>".repeat(201)}</button>`);
      let result = await snapshots.snapshot();
      const record = result.records.find((item) => item.role === "button")!;
      assert.ok(record);
      assert.equal(record.ref, undefined);
      assert.ok(
        result.omitted.some((notice) =>
          /semantic names were incomplete/.test(notice),
        ),
      );
      await page
        .locator("button span")
        .last()
        .evaluate((node) => {
          node.textContent = "changed tail";
        });
      result = await snapshots.snapshot();
      assert.equal(
        result.records.find((item) => item.role === "button")?.ref,
        undefined,
      );

      await page.setContent("<button>short</button>");
      result = await snapshots.snapshot();
      const ref = result.records.find((item) => item.role === "button")?.ref;
      assert.ok(ref);
      await page.locator("button").evaluate((button) => {
        button.innerHTML = "<span>x</span>".repeat(201);
      });
      await assert.rejects(snapshots.resolve(ref), /Stale reference/);

      await page.setContent(
        `<button aria-label="${"a".repeat(241)}"></button>`,
      );
      result = await snapshots.snapshot();
      assert.equal(
        result.records.find((item) => item.role === "button")?.ref,
        undefined,
      );
    } finally {
      await snapshots.dispose();
      await browser.close();
    }
  },
);
