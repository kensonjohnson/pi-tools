import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type CDPSession, type Page } from "playwright";

async function inspectAt(page: Page, cdp: CDPSession, x: number, y: number) {
  const result = new Promise<number>((resolve) =>
    cdp.once("Overlay.inspectNodeRequested", (e) => resolve(e.backendNodeId)),
  );
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  return Promise.race([
    result,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("inspect timeout")), 2000),
    ),
  ]);
}

test(
  "inspect mode picks open shadow and same-process iframe without fixture activation",
  { timeout: 30000, skip: process.env.BROWSER_HEADED !== "1" },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<div id="host"></div><iframe style="width:240px;height:140px" srcdoc="<button id='inner' style='width:120px;height:70px'>Frame</button><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++)</script>"></iframe><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++);host.attachShadow({mode:'open'}).innerHTML='<button id="shadow" style="width:120px;height:70px">Shadow</button>'</script>`,
      );
      await page.frameLocator("iframe").locator("#inner").waitFor();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("Overlay.enable");
      await cdp.send("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: { showInfo: true },
      });
      const shadow = await page.locator("#shadow").boundingBox();
      assert(shadow);
      const shadowId = await inspectAt(
        page,
        cdp,
        shadow.x + shadow.width / 2,
        shadow.y + shadow.height / 2,
      );
      assert.equal(
        (await cdp.send("DOM.describeNode", { backendNodeId: shadowId })).node
          .nodeName,
        "BUTTON",
      );
      const child = await page
        .frameLocator("iframe")
        .locator("#inner")
        .boundingBox();
      assert(child);
      const childId = await inspectAt(
        page,
        cdp,
        child.x + child.width / 2,
        child.y + child.height / 2,
      );
      assert.equal(
        (await cdp.send("DOM.describeNode", { backendNodeId: childId })).node
          .nodeName,
        "BUTTON",
      );
      assert.notEqual(shadowId, childId);
      assert.equal(await page.evaluate(() => (window as any).clicks), 0);
      assert.equal(
        await page
          .frameLocator("iframe")
          .locator("body")
          .evaluate(() => (window as any).clicks),
        0,
      );
      await cdp.send("Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: {},
      });
      await cdp.detach();
    } finally {
      await browser.close();
    }
  },
);

test(
  "abort and main navigation explicitly disable inspect mode before restoring input",
  { timeout: 30000, skip: process.env.BROWSER_HEADED !== "1" },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<button id="b">Button</button><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++)</script>`,
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("Overlay.enable");
      const enable = () =>
        cdp.send("Overlay.setInspectMode", {
          mode: "searchForNode",
          highlightConfig: { showInfo: true },
        });
      const disable = () =>
        cdp.send("Overlay.setInspectMode", {
          mode: "none",
          highlightConfig: {},
        });
      await enable();
      const controller = new AbortController();
      const abortCleanup = new Promise<void>((resolve, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => {
            disable().then(() => resolve(), reject);
          },
          { once: true },
        ),
      );
      controller.abort();
      await abortCleanup;
      await page.locator("#b").click();
      assert.equal(await page.evaluate(() => (window as any).clicks), 1);
      await enable();
      // The test explicitly invalidates and disables on observed navigation; events during the gap are not certified.
      await page.goto(
        'data:text/html,<button id="b">New</button><script>window.clicks=0;document.addEventListener("click",()=>window.clicks++)</script>',
      );
      await disable();
      await page.locator("#b").click();
      assert.equal(await page.evaluate(() => (window as any).clicks), 1);
      await cdp.detach();
    } finally {
      await browser.close();
    }
  },
);
