import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";

test(
  "root input gate across main-document navigation",
  { timeout: 30000, skip: process.env.BROWSER_HEADED !== "1" },
  async () => {
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<button style="width:180px;height:100px">Button</button><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++)</script>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const browser = await chromium.launch({
      headless: false,
      args: ["--site-per-process"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/first`);
      const root = await page.context().newCDPSession(page);
      await root.send("Input.setIgnoreInputEvents", { ignore: true });
      await page.goto(`http://localhost:${port}/second`);
      const box = await page.getByRole("button").boundingBox();
      assert(box);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(100);
      const count = await page.evaluate(() => (window as any).clicks);
      console.log("cross-site main navigation, gated count:", count);
      assert.equal(count, 0);
      await root.send("Input.setIgnoreInputEvents", { ignore: false });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      assert.equal(await page.evaluate(() => (window as any).clicks), 1);
      await root.detach();
    } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
