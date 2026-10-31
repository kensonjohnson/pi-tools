import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { extractPage } from "./extraction.ts";
import { SemanticSnapshots } from "./semantic-snapshots.ts";

test("budget validation fails before browser access", async () => {
  await assert.rejects(
    extractPage(null as any, {}, null, { nodes: Number.MAX_SAFE_INTEGER + 1 }),
    /budget/,
  );
  await assert.rejects(
    extractPage(null as any, {}, null, { chars: Infinity }),
    /budget/,
  );
});

test(
  "larger explicit budgets capture beyond old snapshot and extraction limits",
  { skip: !existsSync(chromium.executablePath()), timeout: 60000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const snapshots = new SemanticSnapshots(page);
    try {
      await page.setContent(
        `<main>${Array.from({ length: 4500 }, (_, i) => `<p>record ${i} ${"x".repeat(75)}</p>`).join("")}</main>`,
      );
      await assert.rejects(extractPage(page), /limit exceeded/);
      const extraction = await extractPage(page, {}, null, {
        nodes: 12000,
        chars: 1024 * 1024,
        depth: 256,
      });
      assert.match(extraction.text, /record 4499/);
      const snapshot = await snapshots.snapshot({
        maxNodes: 12000,
        maxRecords: 1000,
        maxChars: 512000,
      });
      assert.equal(snapshot.records.length, 1000);
      assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 32000);
      assert.ok(
        snapshot.omitted.some((notice) => /limit reached/i.test(notice)),
      );
      await assert.rejects(
        snapshots.snapshot({ maxRecords: Number.MAX_SAFE_INTEGER + 1 }),
        /safe integers/,
      );
      await assert.rejects(
        snapshots.snapshot({ identityNodes: Number.MAX_SAFE_INTEGER + 1 }),
        /safe integers/,
      );
      await assert.rejects(
        snapshots.snapshot({ identityNameChars: 0 }),
        /safe integers/,
      );
      const generous = await snapshots.snapshot({
        maxNodes: 100001,
        maxRecords: 10001,
        maxChars: 2 * 1024 * 1024 + 1,
        maxFrames: 1025,
      });
      assert.equal(generous.records.length, 4500);
      await page.setContent(
        Array.from(
          { length: 33 },
          (_, i) => `<iframe srcdoc='<p>frame ${i}</p>'></iframe>`,
        ).join(""),
      );
      const defaultFrames = await snapshots.snapshot({
        maxNodes: 1000,
        maxRecords: 100,
        maxChars: 50000,
      });
      assert.ok(
        defaultFrames.omitted.some((notice) =>
          /Frame limit reached; 2 frames omitted/.test(notice),
        ),
      );
      const frames = await snapshots.snapshot({
        maxFrames: 40,
        maxNodes: 1000,
        maxRecords: 100,
        maxChars: 50000,
      });
      assert.ok(frames.records.some((r) => r.name === "frame 32"));
      assert.ok(
        !frames.omitted.some((notice) => /Frame limit reached/.test(notice)),
      );
      await page.evaluate(() => {
        document.body.replaceChildren();
        let parent: Element = document.body;
        for (let i = 0; i < 150; i++) {
          const child = document.createElement("div");
          parent.append(child);
          parent = child;
        }
        parent.textContent = "deep content";
      });
      await assert.rejects(extractPage(page), /depth limit exceeded/);
      assert.equal(
        (
          await extractPage(page, {}, null, {
            depth: 200,
            nodes: 100001,
            chars: 4 * 1024 * 1024 + 1,
          })
        ).text,
        "deep content",
      );
      await page.setContent(
        `<title>${"a".repeat(9000)}</title><h1>heading</h1>`,
      );
      await assert.rejects(extractPage(page), /metadata limit/);
      await assert.rejects(
        extractPage(page, {}, null, { metadata: 10000, derivedChars: 2 }),
        /derived heading\/link text limit/,
      );
      assert.equal(
        (
          await extractPage(page, {}, null, {
            metadata: 10000,
            derivedChars: 100,
          })
        ).headings[0].text,
        "heading",
      );
    } finally {
      await snapshots.dispose();
      await browser.close();
    }
  },
);
