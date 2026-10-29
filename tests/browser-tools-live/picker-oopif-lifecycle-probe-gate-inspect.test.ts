import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";

test(
  "gate blocks input during OOPIF inspect setup; release allows selection",
  { timeout: 30000, skip: process.env.BROWSER_HEADED !== "1" },
  async () => {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      const port = (server.address() as any).port;
      res.end(
        req.url === "/child"
          ? `<button style="width:180px;height:100px">Child</button><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++)</script>`
          : `<iframe src="http://localhost:${port}/child"></iframe>`,
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
      await page.goto(`http://127.0.0.1:${port}/`);
      const button = page.frameLocator("iframe").getByRole("button");
      await button.waitFor();
      const frame = page.frames().find((f) => f.url().includes("/child"));
      assert(frame);
      const box = await button.boundingBox();
      assert(box);
      const click = async () => {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(100);
      };
      const root = await page.context().newCDPSession(page);
      await root.send("Input.setIgnoreInputEvents", { ignore: true });
      await click();
      assert.equal(await frame.evaluate(() => (window as any).clicks), 0);
      await root.send("DOM.enable");
      await root.send("Overlay.enable");
      await root.send("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: { showInfo: true },
      });
      const child = await page.context().newCDPSession(frame);
      await child.send("DOM.enable");
      await child.send("Overlay.enable");
      let selections = 0;
      child.on("Overlay.inspectNodeRequested", () => selections++);
      await child.send("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: { showInfo: true },
      });
      await click();
      assert.equal(selections, 0);
      assert.equal(await frame.evaluate(() => (window as any).clicks), 0);
      await root.send("Input.setIgnoreInputEvents", { ignore: false });
      await click();
      assert.equal(selections, 1);
      assert.equal(await frame.evaluate(() => (window as any).clicks), 0);
      await root.send("Input.setIgnoreInputEvents", { ignore: true });
      await child.send("Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: {},
      });
      await root.send("Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: {},
      });
      await click();
      assert.equal(await frame.evaluate(() => (window as any).clicks), 0);
      await root.send("Input.setIgnoreInputEvents", { ignore: false });
      await click();
      assert.equal(await frame.evaluate(() => (window as any).clicks), 1);
      await child.detach();
      await root.detach();
    } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
