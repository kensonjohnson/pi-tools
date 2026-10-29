import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";

test(
  "autoattach cannot pause an already running OOPIF before installation",
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
      const root = await page.context().newCDPSession(page);
      await root.send("DOM.enable");
      await root.send("Overlay.enable");
      await root.send("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: { showInfo: true },
      });
      const attached = new Promise<any>((resolve) =>
        root.on("Target.attachedToTarget", resolve),
      );
      await root.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: false,
      });
      const event = await attached;
      assert.equal(event.targetInfo.type, "iframe");
      assert.equal(event.waitingForDebugger, false);
      const box = await button.boundingBox();
      assert(box);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const frame = page.frames().find((f) => f.url().includes("/child"));
      assert(frame);
      assert.equal(await frame.evaluate(() => (window as any).clicks), 1);
      await root.send("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: false,
      });
      await root.send("Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: {},
      });
      await root.detach();
    } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
