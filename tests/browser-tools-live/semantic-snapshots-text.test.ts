import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { SemanticSnapshots } from "../../extensions/browser-tools/semantic-snapshots.ts";

test(
  "text, ordering, scope, visibility and byte budget",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<section id="scope"><h2>Heading <span hidden>secret-hidden</span></h2><p>First <b>paragraph</b></p><button>Go</button><div style="height:3000px"></div><p>Offscreen text</p><p hidden>hidden-text</p><script>"script-secret"</script><textarea aria-label="Message">normal value</textarea><input type="password" value="secret-password"><input type="hidden" value="secret-field"></section><p>Outside</p>`,
      );
      const service = new SemanticSnapshots(page);
      const result = await service.snapshot({ selector: "#scope" });
      const names = result.records.map((r) => r.name);
      for (const text of [
        "Heading",
        "First",
        "paragraph",
        "Go",
        "Offscreen text",
        "Message",
      ])
        assert(names.includes(text), text);
      assert(names.indexOf("Heading") < names.indexOf("First"));
      assert(names.indexOf("paragraph") < names.indexOf("Go"));
      assert(names.indexOf("Go") < names.indexOf("Offscreen text"));
      assert(!JSON.stringify(result).includes("secret"));
      assert(!names.includes("Outside"));
      assert(result.omitted.some((x) => /Closed shadow/.test(x)));
      await page
        .locator("#scope")
        .evaluate((el) => el.setAttribute("hidden", ""));
      await assert.rejects(service.snapshot({ selector: "#scope" }), /hidden/i);
      await page
        .locator("#scope")
        .evaluate((el) => el.removeAttribute("hidden"));
      await page.evaluate(() => {
        const p = document.createElement("p");
        p.textContent = "🦊".repeat(300);
        document.body.append(p);
      });
      const bounded = await service.snapshot({ maxChars: 512 });
      assert(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 512);
      assert(bounded.omitted.some((x) => /omitted|clipped/.test(x)));
      await page.evaluate(() => {
        const p = document.createElement("p");
        p.id = "unicode";
        p.textContent = "🦊".repeat(50);
        document.body.append(p);
      });
      const unicode = await service.snapshot({
        selector: "#unicode",
        maxChars: 700,
      });
      assert(unicode.records.some((r) => r.name.includes("🦊")));
      assert(Buffer.byteLength(JSON.stringify(unicode), "utf8") <= 700);
      const narrow = await service.snapshot({ maxNodes: 3 });
      assert(narrow.omitted.some((x) => /Traversal limit reached/.test(x)));
      await assert.rejects(service.snapshot({ maxNodes: NaN }), /limits/);
      await service.dispose();
    } finally {
      await browser.close();
    }
  },
);

test(
  "spoofed input getter rejects capture without disclosing values",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<input type="password" value="secret"><script>Object.defineProperty(HTMLInputElement.prototype, 'type', {get(){return 'text'}})</script>`,
      );
      const service = new SemanticSnapshots(page);
      await assert.rejects(service.snapshot(), /safely determine/);
      await service.dispose();
    } finally {
      await browser.close();
    }
  },
);
