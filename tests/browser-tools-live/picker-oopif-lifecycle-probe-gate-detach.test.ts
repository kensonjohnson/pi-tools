import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

test(
  "ignore-input session detach and keyboard activation",
  { timeout: 30000, skip: process.env.BROWSER_HEADED !== "1" },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<button style="width:180px;height:100px">Button</button><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++)</script>`,
      );
      const box = await page.getByRole("button").boundingBox();
      assert(box);
      await page.getByRole("button").focus();
      const root = await page.context().newCDPSession(page);
      await root.send("Input.setIgnoreInputEvents", { ignore: true });
      await page.keyboard.press("Enter");
      assert.equal(await page.evaluate(() => (window as any).clicks), 0);
      await page.evaluate(() =>
        (document.querySelector("button") as HTMLButtonElement).click(),
      );
      assert.equal(await page.evaluate(() => (window as any).clicks), 1);
      await root.detach();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(100);
      const after = await page.evaluate(() => (window as any).clicks);
      console.log("count after gated session detach:", after);
      assert.equal(after, 2);
    } finally {
      await browser.close();
    }
  },
);
