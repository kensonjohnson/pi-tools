import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type CDPSession } from "playwright";

async function axButton(cdp: CDPSession, name: string, frameId?: string) {
  const { nodes } = await cdp.send(
    "Accessibility.getFullAXTree",
    frameId ? { frameId } : {},
  );
  const node = nodes.find(
    (n) => n.role?.value === "button" && n.name?.value === name,
  );
  assert(node?.backendDOMNodeId);
  const { object } = await cdp.send("DOM.resolveNode", {
    backendNodeId: node.backendDOMNodeId,
    objectGroup: "probe",
  });
  assert(object.objectId);
  return object.objectId;
}

// Fixture-only synthetic activation, not an implementation of trusted pointer input.
async function attempt(cdp: CDPSession, objectId: string) {
  try {
    const response = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        if (!(this instanceof HTMLButtonElement) || !this.isConnected || this.ownerDocument !== document || this.disabled) return 'stale';
        this.click(); return 'clicked';
      }`,
      returnByValue: true,
    });
    return response.exceptionDetails ? "error" : response.result.value;
  } catch {
    return "error";
  }
}

test(
  "CDP resolved node synthetic fixture action never reselects replacement or new document",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<button id="target">Save</button><script>window.events=[];document.addEventListener('click',e=>window.events.push({id:e.target.id,trusted:e.isTrusted}))</script>`,
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("Accessibility.enable");
      const first = await axButton(cdp, "Save");
      const other = await page.context().newCDPSession(page);
      assert.equal(await attempt(other, first), "error");
      await other.detach();
      assert.equal(await attempt(cdp, first), "clicked");
      assert.deepEqual(await page.evaluate(() => (window as any).events), [
        { id: "target", trusted: false },
      ]);
      await page
        .locator("#target")
        .evaluate((el) => el.replaceWith(el.cloneNode(true)));
      assert.equal(await attempt(cdp, first), "stale");
      assert.equal(
        (await page.evaluate(() => (window as any).events)).length,
        1,
      );
      const second = await axButton(cdp, "Save");
      await page.goto(
        'data:text/html,<button id="target">Save</button><script>window.clicks=0;document.addEventListener("click",()=>window.clicks++)</script>',
      );
      assert.notEqual(await attempt(cdp, second), "clicked");
      assert.equal(await page.evaluate(() => (window as any).clicks), 0);
      await cdp.send("Runtime.releaseObjectGroup", { objectGroup: "probe" });
      await cdp.detach();
    } finally {
      await browser.close();
    }
  },
);

test(
  "CDP frame AX remote node is invalid after child navigation and session detach",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<iframe srcdoc="<button>Child</button><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++)</script>"></iframe>`,
      );
      const frame = page.frameLocator("iframe");
      await frame.getByRole("button").waitFor();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("Accessibility.enable");
      const tree = await cdp.send("Page.getFrameTree");
      const id = tree.frameTree.childFrames?.[0]?.frame.id;
      assert(id);
      const node = await axButton(cdp, "Child", id);
      assert.equal(await attempt(cdp, node), "clicked");
      assert.equal(
        await frame.locator("body").evaluate(() => (window as any).clicks),
        1,
      );
      const navigated = page.waitForEvent(
        "framenavigated",
        (frame) => frame !== page.mainFrame(),
      );
      await page.locator("iframe").evaluate((el) => {
        (el as HTMLIFrameElement).srcdoc =
          `<button>Child</button><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++)</script>`;
      });
      await navigated;
      await frame.getByRole("button").waitFor();
      assert.notEqual(await attempt(cdp, node), "clicked");
      assert.equal(
        await frame.locator("body").evaluate(() => (window as any).clicks),
        0,
      );
      await cdp.detach();
      assert.equal(await attempt(cdp, node), "error");
    } finally {
      await browser.close();
    }
  },
);
