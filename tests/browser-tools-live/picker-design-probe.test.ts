import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

test(
  "CDP accessibility backend ids bind the original node, but not current semantics",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<button id="target">Original</button><div id="host"></div><script>host.attachShadow({mode:"open"}).innerHTML="<button>Shadow</button>"</script>',
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("Accessibility.enable");
      const tree = await cdp.send("Accessibility.getFullAXTree");
      const original = tree.nodes.find(
        (n) => n.role?.value === "button" && n.name?.value === "Original",
      );
      const shadow = tree.nodes.find(
        (n) => n.role?.value === "button" && n.name?.value === "Shadow",
      );
      assert(original?.backendDOMNodeId);
      assert(shadow?.backendDOMNodeId);
      await page.evaluate(() => {
        const node = document.querySelector("#target")!;
        node.textContent = "Changed";
        node.replaceWith(node.cloneNode(true));
      });
      const resolved = await cdp.send("DOM.resolveNode", {
        backendNodeId: original.backendDOMNodeId,
      });
      assert(resolved.object.objectId);
      const connected = await cdp.send("Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: "function(){return this.isConnected}",
        returnByValue: true,
      });
      assert.equal(connected.result.value, false);
      const shadowNode = await cdp.send("DOM.describeNode", {
        backendNodeId: shadow.backendDOMNodeId,
      });
      assert.equal(shadowNode.node.nodeName, "BUTTON");
      await cdp.send("Runtime.releaseObject", {
        objectId: resolved.object.objectId,
      });
      await cdp.detach();
    } finally {
      await browser.close();
    }
  },
);

test(
  "CDP inspect mode intercepts pointer before existing page listeners and reports selected backend node",
  { timeout: 30000, skip: process.env.BROWSER_HEADED !== "1" },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<button id="b" style="width:180px;height:100px">Pick</button><script>window.events=[]; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) window.addEventListener(type, e => window.events.push(type), true)</script>`,
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("Overlay.enable");
      const selected = new Promise<number>((resolve) =>
        cdp.once("Overlay.inspectNodeRequested", (event) =>
          resolve(event.backendNodeId),
        ),
      );
      await cdp.send("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: { showInfo: true },
      });
      const box = await page.locator("#b").boundingBox();
      assert(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const backendNodeId = await Promise.race([
        selected,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("inspect timeout")), 3000),
        ),
      ]);
      const described = await cdp.send("DOM.describeNode", { backendNodeId });
      assert.equal(described.node.nodeName, "BUTTON");
      assert.deepEqual(await page.evaluate(() => (window as any).events), []);
      const second = new Promise<number>((resolve) =>
        cdp.once("Overlay.inspectNodeRequested", (event) =>
          resolve(event.backendNodeId),
        ),
      );
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      assert.equal(
        await Promise.race([
          second,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("second inspect timeout")), 3000),
          ),
        ]),
        backendNodeId,
      );
      assert.deepEqual(await page.evaluate(() => (window as any).events), []);
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
