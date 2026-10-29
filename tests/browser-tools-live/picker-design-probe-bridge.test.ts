import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

test(
  "experimental main-world promise bridge keeps CDP node identity through Playwright trusted dispatch and replacement",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<button id="target" disabled>Save</button><script>window.events=[];document.addEventListener('click',e=>window.events.push({id:e.target.id,trusted:e.isTrusted}))</script>`,
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("Accessibility.enable");
      const ax = await cdp.send("Accessibility.getFullAXTree");
      const node = ax.nodes.find(
        (n) => n.role?.value === "button" && n.name?.value === "Save",
      );
      assert(node?.backendDOMNodeId);
      const obj = await cdp.send("DOM.resolveNode", {
        backendNodeId: node.backendDOMNodeId,
      });
      assert(obj.object.objectId);
      const key = "__probe_" + randomUUID().replaceAll("-", "");
      const pending = page.evaluateHandle(
        (k) =>
          new Promise((resolve) => {
            (window as any)[k] = resolve;
          }),
        key,
      );
      await page.waitForFunction(
        (k) => typeof (window as any)[k] === "function",
        key,
      );
      const delivered = await cdp.send("Runtime.callFunctionOn", {
        objectId: obj.object.objectId,
        functionDeclaration:
          'function(k){const f=window[k]; delete window[k]; if(typeof f!=="function") return false; f(this); return true}',
        arguments: [{ value: key }],
        returnByValue: true,
      });
      assert.equal(delivered.result.value, true);
      const handle = (await pending).asElement();
      assert(handle);
      const click = handle.click({ timeout: 2000 }).then(
        () => "clicked",
        () => "failed",
      );
      await page.waitForTimeout(100);
      await page.locator("#target").evaluate((el) => {
        (el as HTMLButtonElement).disabled = false;
      });
      assert.equal(await click, "clicked");
      assert.deepEqual(await page.evaluate(() => (window as any).events), [
        { id: "target", trusted: true },
      ]);
      await page
        .locator("#target")
        .evaluate((el) => el.replaceWith(el.cloneNode(true)));
      assert.equal(await handle.evaluate((el) => el.isConnected), false);
      await assert.rejects(handle.click({ timeout: 500 }));
      assert.equal(
        (await page.evaluate(() => (window as any).events)).length,
        1,
      );
      await handle.dispose();
      await cdp.send("Runtime.releaseObject", {
        objectId: obj.object.objectId,
      });
      await cdp.detach();
    } finally {
      await browser.close();
    }
  },
);
