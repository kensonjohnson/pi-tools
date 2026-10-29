import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

test(
  "page code can spoof a main-world promise bridge despite CDP delivery reporting success",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<button id="original">A</button><button id="other">B</button>',
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("Accessibility.enable");
      const ax = await cdp.send("Accessibility.getFullAXTree");
      const a = ax.nodes.find((n) => n.name?.value === "A");
      assert(a?.backendDOMNodeId);
      const obj = await cdp.send("DOM.resolveNode", {
        backendNodeId: a.backendDOMNodeId,
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
      await page.evaluate(
        (k) => (window as any)[k](document.querySelector("#other")),
        key,
      );
      const delivered = await cdp.send("Runtime.callFunctionOn", {
        objectId: obj.object.objectId,
        functionDeclaration:
          "function(k){const f=window[k];delete window[k]; f(this); return true}",
        arguments: [{ value: key }],
        returnByValue: true,
      });
      assert.equal(delivered.result.value, true);
      const handle = (await pending).asElement();
      assert(handle);
      assert.equal(await handle.getAttribute("id"), "other");
      await handle.dispose();
      await cdp.detach();
    } finally {
      await browser.close();
    }
  },
);

test(
  "inspect selection is discarded when main navigation precedes resolution",
  { timeout: 30000, skip: process.env.BROWSER_HEADED !== "1" },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<button id="a" style="width:100px;height:80px">A</button>',
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("Overlay.enable");
      const selected = new Promise<number>((resolve) =>
        cdp.once("Overlay.inspectNodeRequested", (e) =>
          resolve(e.backendNodeId),
        ),
      );
      await cdp.send("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: { showInfo: true },
      });
      const box = await page.locator("#a").boundingBox();
      assert(box);
      await page.mouse.move(box.x + 10, box.y + 10);
      await page.mouse.click(box.x + 10, box.y + 10);
      const id = await Promise.race([
        selected,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(Error("inspect timeout")), 2000),
        ),
      ]);
      await page.goto('data:text/html,<button id="a">New</button>');
      const resolved = await cdp
        .send("DOM.resolveNode", { backendNodeId: id })
        .catch(() => null);
      if (resolved?.object.objectId) {
        const check = await cdp
          .send("Runtime.callFunctionOn", {
            objectId: resolved.object.objectId,
            functionDeclaration: "function(){return this.isConnected}",
            returnByValue: true,
          })
          .catch(() => null);
        assert.notEqual(check?.result.value, true);
      }
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
