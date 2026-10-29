import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { extractPage } from "../../extensions/browser-tools/extraction.ts";

test("hidden selected frames and hidden ancestors fail, while about documents retain safe identities", async () => {
  const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.goto("data:text/html,<title>Frame test</title>");
    await page.evaluate(() => {
      document.body.innerHTML = `<iframe id="src" srcdoc="&lt;p&gt;srcdoc content&lt;/p&gt;"></iframe><iframe id="blank"></iframe><iframe id="hidden" style="display:none" srcdoc="&lt;p&gt;hidden secret&lt;/p&gt;"></iframe><div hidden><iframe id="ancestor" srcdoc="&lt;p&gt;ancestor secret&lt;/p&gt;"></iframe></div><div aria-hidden="true"><iframe id="aria" srcdoc="&lt;p&gt;aria secret&lt;/p&gt;"></iframe></div>`;
    });
    await page
      .locator("#blank")
      .contentFrame()
      .locator("body")
      .evaluate((body) => {
        body.textContent = "blank content";
      });
    const src = await extractPage(page, { frameSelector: "#src" });
    const blank = await extractPage(page, { frameSelector: "#blank" });
    assert.equal(src.finalUrl, "about:srcdoc");
    assert.match(src.text, /srcdoc content/);
    assert.equal(blank.finalUrl, "about:blank");
    assert.match(blank.text, /blank content/);
    assert.match(src.omissions, /before and after capture/);
    for (const selector of ["#hidden", "#ancestor", "#aria"]) {
      await assert.rejects(
        extractPage(page, { frameSelector: selector }),
        /frame is hidden/,
      );
    }
    await page.locator("#src").evaluate((el) => {
      (el as HTMLElement).style.visibility = "hidden";
    });
    await assert.rejects(
      extractPage(page, { frameSelector: "#src" }),
      /frame is hidden/,
    );
  } finally {
    await browser.close();
  }
});
