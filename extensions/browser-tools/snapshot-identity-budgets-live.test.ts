import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { SemanticSnapshots } from "./semantic-snapshots.ts";

test(
  "caller identity budgets preserve exact long, deep and node-heavy references",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const snapshots = new SemanticSnapshots(page);
    try {
      await page.setContent(`<div id="root"></div>`);
      await page.evaluate(() => {
        let node = document.querySelector("#root")!;
        for (let i = 0; i < 150; i++) {
          const child = document.createElement("div");
          node.appendChild(child);
          node = child;
        }
        const button = document.createElement("button");
        button.id = "deep";
        button.setAttribute("aria-label", "L".repeat(1300));
        node.appendChild(button);
        const many = document.createElement("button");
        many.id = "many";
        for (let i = 0; i < 220; i++) {
          const child = document.createElement("span");
          child.textContent = "x";
          many.appendChild(child);
        }
        document.body.appendChild(many);
      });
      const ordinary = await snapshots.snapshot({
        maxNodes: 2000,
        maxRecords: 200,
        maxChars: 100000,
      });
      assert.ok(
        ordinary.omitted.some((notice) =>
          /metadata or label count|incomplete/.test(notice),
        ),
      );
      assert.equal(
        ordinary.records.find((r) => r.name.startsWith("LLLL"))?.ref,
        undefined,
      );
      assert.equal(
        ordinary.records.find((r) => r.name.startsWith("x x"))?.ref,
        undefined,
      );
      const expanded = await snapshots.snapshot({
        maxNodes: 2000,
        maxRecords: 200,
        maxChars: 100000,
        identityNameChars: 1600,
        identityTextChars: 2000,
        identityNodes: 1000,
        identityAncestors: 250,
        identityMetadataChars: 1600,
      });
      const deep = expanded.records.find((r) => r.name === "L".repeat(1300));
      const many = expanded.records.find(
        (r) => r.name === Array(220).fill("x").join(" "),
      );
      assert.ok(deep?.ref);
      assert.ok(many?.ref);
      await snapshots.resolve(deep.ref);
      await snapshots.resolve(many.ref);
      await page.evaluate(() => {
        document
          .querySelector("#deep")!
          .setAttribute("aria-label", "L".repeat(1299) + "Z");
      });
      await assert.rejects(snapshots.resolve(deep.ref), /Stale reference/);
      await page.evaluate(() => {
        document.querySelector("#many span:last-child")!.textContent = "z";
      });
      await assert.rejects(snapshots.resolve(many.ref), /Stale reference/);
      const fresh = await snapshots.snapshot({
        maxNodes: 2000,
        maxRecords: 200,
        maxChars: 100000,
        identityNameChars: 1600,
        identityTextChars: 2000,
        identityNodes: 1000,
        identityAncestors: 250,
        identityMetadataChars: 1600,
      });
      const ref = fresh.records.find(
        (r) => r.name.endsWith("Z") && r.name.length === 1300,
      )?.ref;
      assert.ok(ref);
      await page.evaluate(() => {
        document.querySelector("#root")!.setAttribute("hidden", "");
      });
      await assert.rejects(snapshots.resolve(ref), /Stale reference/);
    } finally {
      await snapshots.dispose();
      await browser.close();
    }
  },
);

test(
  "label-count identity budget retains and validates all label text",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const snapshots = new SemanticSnapshots(page);
    try {
      await page.setContent(
        `${Array.from({ length: 20 }, (_, i) => `<span id="l${i}">label${i}</span>`).join("")}<button aria-labelledby="${Array.from({ length: 20 }, (_, i) => `l${i}`).join(" ")}"></button>`,
      );
      const limited = await snapshots.snapshot({ maxChars: 30000 });
      assert.equal(
        limited.records.find((item) => item.role === "button")?.ref,
        undefined,
      );
      assert.ok(
        limited.omitted.some((notice) =>
          /metadata or label count/.test(notice),
        ),
      );
      const expanded = await snapshots.snapshot({
        maxChars: 30000,
        identityLabels: 25,
      });
      const ref = expanded.records.find((item) => item.role === "button")?.ref;
      assert.ok(ref);
      await snapshots.resolve(ref);
      await page.locator("#l19").evaluate((node) => {
        node.textContent = "changed";
      });
      await assert.rejects(snapshots.resolve(ref), /Stale reference/);
    } finally {
      await snapshots.dispose();
      await browser.close();
    }
  },
);

test(
  "frame ancestry can exceed the former depth 32 limit",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const snapshots = new SemanticSnapshots(page);
    try {
      await page.setContent("<body></body>");
      await page.evaluate(() => {
        let doc = document;
        for (let i = 0; i < 34; i++) {
          const frame = doc.createElement("iframe");
          doc.body.appendChild(frame);
          doc = frame.contentDocument!;
        }
        doc.body.innerHTML = "<button>Deep frame target</button>";
      });
      let deepest = page.mainFrame();
      for (let i = 0; i < 34; i++) {
        const child = deepest.childFrames()[0];
        assert.ok(child);
        deepest = child;
      }
      const limited = await snapshots.snapshot({ frame: deepest });
      assert.ok(
        limited.omitted.some((notice) =>
          /frame ancestry budget exceeded/.test(notice),
        ),
      );
      const expanded = await snapshots.snapshot({
        frame: deepest,
        identityFrameDepth: 40,
      });
      const ref = expanded.records.find(
        (record) => record.name === "Deep frame target",
      )?.ref;
      assert.ok(ref);
      await snapshots.resolve(ref);
    } finally {
      await snapshots.dispose();
      await browser.close();
    }
  },
);

test(
  "nested frame ancestry budgets are retained for validation",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const snapshots = new SemanticSnapshots(page);
    try {
      await page.setContent('<iframe id="outer"></iframe>');
      const outer = await page.locator("#outer").contentFrame();
      assert.ok(outer);
      await outer.locator("body").evaluate((body) => {
        body.innerHTML = '<iframe id="inner"></iframe>';
      });
      const inner = await outer.locator("#inner").contentFrame();
      assert.ok(inner);
      await inner.locator("body").evaluate((body) => {
        body.innerHTML = "<button>Nested</button>";
      });
      const frames = page.frames();
      const target = frames.find(
        (frame) =>
          frame.parentFrame() && frame.parentFrame() !== page.mainFrame(),
      );
      assert.ok(target);
      const limited = await snapshots.snapshot({
        frame: target,
        identityFrameDepth: 1,
      });
      assert.ok(
        limited.omitted.some((notice) =>
          /frame ancestry budget exceeded/.test(notice),
        ),
      );
      const expanded = await snapshots.snapshot({
        frame: target,
        identityFrameDepth: 2,
      });
      const ref = expanded.records.find(
        (record) => record.name === "Nested",
      )?.ref;
      assert.ok(ref);
      await snapshots.resolve(ref);
      await page
        .locator("#outer")
        .evaluate((node) => node.setAttribute("hidden", ""));
      await assert.rejects(snapshots.resolve(ref), /Stale reference/);
    } finally {
      await snapshots.dispose();
      await browser.close();
    }
  },
);
