import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";

test(
  "Input ignore coverage on root and OOPIF targets",
  { timeout: 30000, skip: process.env.BROWSER_HEADED !== "1" },
  async () => {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        req.url?.startsWith("/child")
          ? `<button style="width:160px;height:100px">Child</button><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++)</script>`
          : `<button id="root" style="width:160px;height:100px">Root</button><div id="host"></div><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++)</script>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const browser = await chromium.launch({
      headless: false,
      args: ["--site-per-process"],
    });
    try {
      const browserSession = await browser.newBrowserCDPSession();
      const browserResult = await browserSession
        .send("Input.setIgnoreInputEvents", { ignore: true })
        .then(
          () => "accepted",
          (e) => String(e),
        );
      console.log("browser target:", browserResult);
      assert.match(browserResult, /wasn't found|not found|not supported/i);
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      const root = await page.context().newCDPSession(page);
      await root.send("Input.setIgnoreInputEvents", { ignore: true });
      await page.evaluate((url) => {
        const f = document.createElement("iframe");
        f.src = url;
        document.querySelector("#host")!.append(f);
      }, `http://localhost:${port}/child`);
      const childButton = page.frameLocator("iframe").getByRole("button");
      await childButton.waitFor();
      const frame = page.frames().find((f) => f.url().includes("/child"));
      assert(frame);
      const rootBox = await page.locator("#root").boundingBox();
      const childBox = await childButton.boundingBox();
      assert(rootBox && childBox);
      const click = async (box: typeof rootBox) => {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(100);
      };
      await click(rootBox);
      await click(childBox);
      const rootIgnored = await page.evaluate(() => (window as any).clicks);
      const childIgnored = await frame.evaluate(() => (window as any).clicks);
      console.log("root ignore, root/child counts:", rootIgnored, childIgnored);
      assert.equal(rootIgnored, 0);
      assert.equal(childIgnored, 0);
      await frame.goto(`http://localhost:${port}/child?second`);
      await childButton.waitFor();
      const nextFrame = page
        .frames()
        .find((f) => f.url().includes("/child?second"));
      assert(nextFrame);
      await click(childBox);
      assert.equal(await nextFrame.evaluate(() => (window as any).clicks), 0);
      const childSession = await page.context().newCDPSession(frame);
      await childSession.send("Input.setIgnoreInputEvents", { ignore: true });
      await click(childBox);
      const childBoth = await frame.evaluate(() => (window as any).clicks);
      console.log("root and child ignore, child count:", childBoth);
      assert.equal(childBoth, 0);
      await root.send("Input.setIgnoreInputEvents", { ignore: false });
      await click(rootBox);
      await click(childBox);
      const rootReleased = await page.evaluate(() => (window as any).clicks);
      const childRootReleased = await frame.evaluate(
        () => (window as any).clicks,
      );
      console.log(
        "child ignore only, root/child counts:",
        rootReleased,
        childRootReleased,
      );
      await childSession.send("Input.setIgnoreInputEvents", { ignore: false });
      await click(childBox);
      const childReleased = await frame.evaluate(() => (window as any).clicks);
      console.log("all released, child count:", childReleased);
      assert.equal(rootReleased, 0);
      assert.equal(childRootReleased, 0);
      assert.equal(childReleased, childRootReleased + 1);
      await click(rootBox);
      assert.equal(await page.evaluate(() => (window as any).clicks), 1);
      await childSession.detach();
      await root.detach();
      await browserSession.detach();
    } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
