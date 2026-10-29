import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

test(
  "losing the gate permits activation before owned browser closure",
  { timeout: 30000, skip: process.env.BROWSER_HEADED !== "1" },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.setContent(`<button style="width:180px;height:100px">Button</button>
        <script>window.clicks = 0; document.addEventListener('click', () => window.clicks++)</script>`);
      const box = await page.getByRole("button").boundingBox();
      assert(box);
      const gate = await page.context().newCDPSession(page);
      await gate.send("Input.setIgnoreInputEvents", { ignore: true });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      assert.equal(await page.evaluate(() => (window as any).clicks), 0);

      // A transport failure can release the gate before any asynchronous owner
      // observes it and closes the browser. Detach models that lost gate.
      await gate.detach();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      assert.equal(await page.evaluate(() => (window as any).clicks), 1);
      await browser.close();
      assert.equal(browser.isConnected(), false);
    } finally {
      await browser.close();
    }
  },
);

test(
  "closing a connected client does not close its browser server",
  { timeout: 30000 },
  async () => {
    const server = await chromium.launchServer({ headless: true });
    try {
      const client = await chromium.connect(server.wsEndpoint());
      await client.close();
      assert.equal(client.isConnected(), false);
      const observer = await chromium.connect(server.wsEndpoint());
      try {
        assert.equal(observer.isConnected(), true);
      } finally {
        await observer.close();
      }
    } finally {
      await server.close();
    }
  },
);
