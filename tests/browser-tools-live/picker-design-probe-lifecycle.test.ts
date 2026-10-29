import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

test(
  "inspect Escape and explicit cancellation release input",
  { timeout: 30000, skip: process.env.BROWSER_HEADED !== "1" },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<button id="b" style="width:160px;height:100px">Pick</button><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++)</script>`,
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("Overlay.enable");
      await cdp.send("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: { showInfo: true },
      });
      let cancelled = 0;
      cdp.on("Overlay.inspectModeCanceled", () => cancelled++);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      assert.equal(cancelled, 1);
      await page.locator("#b").click();
      assert.equal(await page.evaluate(() => (window as any).clicks), 0);
      await cdp.send("Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: {},
      });
      await page.locator("#b").click();
      assert.equal(await page.evaluate(() => (window as any).clicks), 1);
      await cdp.detach();
    } finally {
      await browser.close();
    }
  },
);

test(
  "AX snapshot exposes same-process frame and shadow nodes with backend ids",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<iframe srcdoc="<button>Frame button</button>"></iframe><div id="h"></div><script>h.attachShadow({mode:'closed'}).innerHTML='<button>Closed button</button>'</script>`,
      );
      await page.locator("iframe").contentFrame().getByRole("button").waitFor();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("Accessibility.enable");
      const main = await cdp.send("Accessibility.getFullAXTree");
      const frame = await cdp.send("Page.getFrameTree");
      const child = frame.frameTree.childFrames?.[0];
      assert(child);
      const inner = await cdp.send("Accessibility.getFullAXTree", {
        frameId: child.frame.id,
      });
      const frameButton = inner.nodes.find(
        (n) => n.role?.value === "button" && n.name?.value === "Frame button",
      );
      const closedButton = main.nodes.find(
        (n) => n.role?.value === "button" && n.name?.value === "Closed button",
      );
      assert(frameButton?.backendDOMNodeId);
      assert(closedButton?.backendDOMNodeId);
      assert.equal(
        (
          await cdp.send("DOM.describeNode", {
            backendNodeId: frameButton.backendDOMNodeId,
          })
        ).node.nodeName,
        "BUTTON",
      );
      assert.equal(
        (
          await cdp.send("DOM.describeNode", {
            backendNodeId: closedButton.backendDOMNodeId,
          })
        ).node.nodeName,
        "BUTTON",
      );
      await cdp.detach();
    } finally {
      await browser.close();
    }
  },
);
