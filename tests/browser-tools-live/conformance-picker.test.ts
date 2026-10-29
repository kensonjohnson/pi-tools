import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "headed native picker Escape, navigation, link and repeated selection observations",
  { skip: process.env.BROWSER_HEADED !== "1", timeout: 30000 },
  async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      if (req.url === "/frame") {
        res.end(
          '<button id="frame-button">Frame button</button><script>window.clicks=0;document.querySelector("button").onclick=()=>window.clicks++</script>',
        );
        return;
      }
      res.end(
        '<a href="/activated" id="link">Link</a><button id="button">Button</button><iframe title="child" src="/frame"></iframe><div id="host"></div><script>window.clicks=0;document.querySelector("button").onclick=()=>window.clicks++;document.querySelector("#host").attachShadow({mode:"open"}).innerHTML="<button id=shadow>Shadow button</button>";document.querySelector("#host").shadowRoot.querySelector("button").onclick=()=>window.clicks++</script>',
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      const pick = () =>
        page.pickLocator().then(
          (locator) => ({ status: "selected", locator }),
          (error) => ({ status: "rejected", error }),
        );
      let pending = pick();
      await delay(400);
      await page.keyboard.press("Escape");
      let observation = await Promise.race([
        pending,
        delay(400).then(() => ({ status: "pending" })),
      ]);
      console.log("picker Escape:", observation.status);
      if (observation.status === "pending") {
        await page.cancelPickLocator();
        await pending;
      }
      pending = pick();
      await delay(400);
      await page.goto(url + "/navigation");
      observation = await Promise.race([
        pending,
        delay(400).then(() => ({ status: "pending" })),
      ]);
      console.log("picker navigation:", observation.status);
      if (observation.status === "pending") {
        await page.cancelPickLocator();
        await pending;
      }
      pending = pick();
      await delay(400);
      await page.locator("#link").click();
      const link = await pending;
      assert.equal(link.status, "selected");
      assert.equal(page.url(), url + "/navigation");
      pending = pick();
      await delay(400);
      await page.locator("#button").click();
      const button = await pending;
      assert.equal(button.status, "selected");
      assert.equal(await page.evaluate(() => (window as any).clicks), 0);
      pending = pick();
      await delay(400);
      await page.locator("#shadow").click();
      const shadow = await pending;
      assert.equal(shadow.status, "selected");
      assert.equal(await page.evaluate(() => (window as any).clicks), 0);
      if (shadow.status === "selected" && shadow.locator)
        assert.equal(await shadow.locator.textContent(), "Shadow button");
      pending = pick();
      await delay(400);
      await page.frameLocator("iframe").locator("#frame-button").click();
      const frame = await pending;
      assert.equal(frame.status, "selected");
      assert.equal(
        await page
          .frameLocator("iframe")
          .locator("#frame-button")
          .evaluate((el) => (el.ownerDocument.defaultView as any).clicks),
        0,
      );
      if (frame.status === "selected" && frame.locator)
        assert.equal(await frame.locator.textContent(), "Frame button");
      console.log(
        "picker returns one locator per call; sequential picks observed in main document, open shadow and same-origin frame",
      );
      if (button.status === "selected" && button.locator) {
        const selectedHandle = await button.locator.elementHandle();
        assert(selectedHandle);
        await page
          .locator("#button")
          .evaluate((el) => el.replaceWith(el.cloneNode(true)));
        assert.equal(
          await selectedHandle.evaluate((el) => el.isConnected),
          false,
        );
        await assert.rejects(selectedHandle.click({ timeout: 500 }));
        assert.equal(await button.locator.count(), 1); // Locator silently reselects the replacement.
        await selectedHandle.dispose();
      }
      // A second click after the first selection is ordinary page input, not a second selection.
      await page.locator("#shadow").click();
      assert.equal(await page.evaluate(() => (window as any).clicks), 1);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  },
);
