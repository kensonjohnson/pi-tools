import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { SemanticSnapshots } from "../../extensions/browser-tools/semantic-snapshots.ts";

test(
  "bounded snapshots retain original handles across unrelated changes and reject stale nodes",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<label for="u">User</label><input id="u" value="Ada"><input type="password" aria-label="Password" value="secret"><input type="hidden" value="hidden-secret"><div style="height:3000px"></div><button id="save">Save</button><div id="host"></div><iframe srcdoc="<button>Frame</button>"></iframe><script>host.attachShadow({mode:'open'}).innerHTML='<button>Shadow</button>'</script>`,
      );
      const snapshots = new SemanticSnapshots(page);
      const result = await snapshots.snapshot();
      assert(!JSON.stringify(result).includes("secret"));
      assert.equal(
        result.records.find((r) => r.name === "User" && r.role === "textbox")
          ?.value,
        "Ada",
      );
      for (const name of ["Save", "Shadow", "Frame"])
        assert(
          result.records.some((r) => r.name === name),
          name,
        );
      const save = result.records.find((r) => r.name === "Save")!.ref!;
      await page.evaluate(() =>
        document.body.append(document.createElement("div")),
      );
      assert(await snapshots.resolve(save));
      const otherOwner = new SemanticSnapshots(page);
      await assert.rejects(otherOwner.resolve(save), /Stale/);
      await otherOwner.dispose();
      await page
        .locator("#save")
        .evaluate((el) => el.setAttribute("aria-label", "Changed"));
      await assert.rejects(snapshots.resolve(save), /Stale/);
      await page
        .locator("#save")
        .evaluate((el) => el.removeAttribute("aria-label"));
      await page
        .locator("#save")
        .evaluate((el) => el.replaceWith(el.cloneNode(true)));
      await assert.rejects(snapshots.resolve(save), /Stale/);
      const second = await snapshots.snapshot({ maxChars: 512 });
      assert(JSON.stringify(second).length <= 512);
      assert(second.omitted.some((x) => /limit/i.test(x)));
      const third = await snapshots.snapshot();
      const ref = third.records.find((r) => r.name === "Save")!.ref!;
      await snapshots.snapshot();
      await assert.rejects(snapshots.resolve(ref), /Stale/);
      const fourth = await snapshots.snapshot();
      const navigationRef = fourth.records.find((r) => r.name === "Save")!.ref!;
      await page.goto("data:text/html,<button>Save</button>");
      await assert.rejects(snapshots.resolve(navigationRef), /Stale/);
      await snapshots.dispose();
    } finally {
      await browser.close();
    }
  },
);

test(
  "tampered input type getter fails closed",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<input type="password" value="secret"><script>Object.defineProperty(HTMLInputElement.prototype,'type',{get(){return 'text'}})</script>`,
      );
      const snapshots = new SemanticSnapshots(page);
      await assert.rejects(
        snapshots.snapshot(),
        /safely determine input types/,
      );
      await snapshots.dispose();
    } finally {
      await browser.close();
    }
  },
);
