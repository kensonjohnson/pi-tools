import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

test(
  "page-world input type spoof defeats naive atomic handle capture redaction",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<input id="s" type="password" value="fixture-secret"><script>Object.defineProperty(HTMLInputElement.prototype,'type',{configurable:true,get(){return 'text'}})</script>`,
      );
      const capture = await page.evaluateHandle(() => {
        const node = document.querySelector("input")!;
        return {
          node,
          value:
            node.type === "password" || node.type === "hidden"
              ? null
              : node.value,
        };
      });
      const props = await capture.getProperties();
      const node = props.get("node")!.asElement();
      assert(node);
      assert.equal(await props.get("value")!.jsonValue(), "fixture-secret");
      const cdp = await page.context().newCDPSession(page);
      const frame = await cdp.send("Page.getFrameTree");
      const world = await cdp.send("Page.createIsolatedWorld", {
        frameId: frame.frameTree.frame.id,
        worldName: "semantic-probe",
      });
      const type = await cdp.send("Runtime.evaluate", {
        contextId: world.executionContextId,
        expression: "document.querySelector('input').type",
        returnByValue: true,
      });
      assert.equal(type.result.value, "password");
      await Promise.all([...props.values()].map((h) => h.dispose()));
      await capture.dispose();
      await cdp.detach();
    } finally {
      await browser.close();
    }
  },
);
