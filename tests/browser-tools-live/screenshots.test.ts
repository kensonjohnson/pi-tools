import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ArtifactStore } from "../../extensions/browser-tools/artifacts.ts";
import {
  captureScreenshot,
  setScreenshotViewport,
} from "../../extensions/browser-tools/screenshots.ts";
import { SemanticSnapshots } from "../../extensions/browser-tools/semantic-snapshots.ts";

test(
  "screenshots preserve originals, scope and ownership; responsive sizing is explicit",
  { timeout: 30000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "screenshots-")));
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const artifacts = new ArtifactStore({ root: join(root, "artifacts") });
      const quarantine = () => {
        throw new Error("Unexpected quarantine");
      };
      await setScreenshotViewport(
        page,
        { preset: "phone" },
        undefined,
        undefined,
        quarantine,
      );
      await page.setContent(
        '<style>body{margin:0}button{width:100px;height:50px}main{height:1500px}</style><button>Save</button><main><canvas width="20" height="20"></canvas></main>',
      );
      const take = (
        scope: "viewport" | "fullPage" | "element",
        resolveElement?: () => Promise<any>,
      ) =>
        captureScreenshot({
          page,
          artifacts,
          owner: "one",
          scope,
          resolveElement,
          quarantine,
        });
      const viewport = await take("viewport");
      const meta = JSON.parse(viewport.content[0].text!);
      assert.equal(meta.width, 390);
      assert.equal(meta.height, 844);
      assert.equal(meta.artifact.path, undefined);
      assert(!viewport.content[0].text!.includes(artifacts.root));
      assert.equal(viewport.content[1].type, "image");
      assert(!viewport.content[0].text!.includes(viewport.content[1].data!));
      const full = JSON.parse((await take("fullPage")).content[0].text!);
      assert.equal(full.height, 1550);
      const snapshots = new SemanticSnapshots(page);
      const ref = (await snapshots.snapshot()).records.find(
        (r) => r.name === "Save",
      )!.ref!;
      const element = JSON.parse(
        (await take("element", () => snapshots.resolve(ref))).content[0].text!,
      );
      assert.equal(element.width, 100);
      assert.equal(element.height, 50);
      await page.locator("button").evaluate((el) => el.remove());
      await assert.rejects(
        take("element", () => snapshots.resolve(ref)),
        /Stale/,
      );
      await snapshots.dispose();
      await assert.rejects(
        setScreenshotViewport(page, { width: 0, height: 100 }),
        /geometry/,
      );
      await assert.rejects(
        captureScreenshot({
          page,
          artifacts,
          owner: "one",
          scope: "fullPage",
          quarantine,
          limits: {
            maxDimension: 1000,
            maxPixels: 1000000,
            maxBytes: 1000000,
            timeoutMs: 5000,
          },
        }),
        /limit/,
      );
      const tinyStore = new ArtifactStore({
        root: join(root, "tiny"),
        quota: 1,
      });
      await assert.rejects(
        captureScreenshot({
          page,
          artifacts: tinyStore,
          owner: "one",
          scope: "viewport",
          quarantine,
        }),
        /quota/i,
      );
      await assert.rejects(
        captureScreenshot({
          page,
          artifacts,
          owner: "one",
          scope: "viewport",
          quarantine,
          limits: {
            maxDimension: 8192,
            maxPixels: 16000000,
            maxBytes: 1,
            timeoutMs: 5000,
          },
        }),
        /byte limit/i,
      );
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        captureScreenshot({
          page,
          artifacts,
          owner: "one",
          scope: "viewport",
          quarantine,
          signal: controller.signal,
        }),
        /cancelled/,
      );
      await assert.rejects(
        artifacts.readBinary("other", meta.artifact.id, 0),
        /not found|unavailable/i,
      );
    } finally {
      await browser.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
