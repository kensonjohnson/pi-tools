import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium, type CDPSession } from "playwright";

async function isolatedNode(cdp: CDPSession, selector: string) {
  await cdp.send("Page.enable");
  await cdp.send("DOM.enable");
  const tree = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: tree.frameTree.frame.id,
    worldName: "reference-action-probe",
  });
  const result = await cdp.send("Runtime.evaluate", {
    contextId: executionContextId,
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    objectGroup: "probe",
  });
  assert(result.result.objectId);
  return { objectId: result.result.objectId, contextId: executionContextId };
}
async function targetPoint(
  cdp: CDPSession,
  node: { objectId: string; contextId: number },
) {
  try {
    const state = await cdp.send("Runtime.callFunctionOn", {
      objectId: node.objectId,
      functionDeclaration: `function(){const s=getComputedStyle(this);const r=this.getBoundingClientRect();return this.isConnected && this.ownerDocument===document && !this.matches(':disabled') && s.display!=='none' && s.visibility==='visible' && r.width>0 && r.height>0}`,
      returnByValue: true,
    });
    if (state.result.value !== true) return null;
    const box = await cdp.send("DOM.getBoxModel", { objectId: node.objectId });
    const q = box.model.content;
    const x = Math.floor((q[0] + q[2] + q[4] + q[6]) / 4),
      y = Math.floor((q[1] + q[3] + q[5] + q[7]) / 4);
    const hit = await cdp.send("DOM.getNodeForLocation", {
      x,
      y,
      includeUserAgentShadowDOM: true,
    });
    const obj = await cdp.send("DOM.resolveNode", {
      backendNodeId: hit.backendNodeId,
      executionContextId: node.contextId,
      objectGroup: "probe",
    });
    if (!obj.object.objectId) return null;
    const contained = await cdp.send("Runtime.callFunctionOn", {
      objectId: node.objectId,
      functionDeclaration:
        "function(other){return this===other || this.contains(other)}",
      arguments: [{ objectId: obj.object.objectId }],
      returnByValue: true,
    });
    return contained.result.value === true ? { x, y } : null;
  } catch {
    return null;
  }
}
async function mouse(cdp: CDPSession, point: { x: number; y: number }) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

test(
  "isolated-node hit testing rejects obscuration and detached replacement, dispatches trusted input on fixture",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<button id="target" style="width:150px;height:90px"><span>Save</span></button><script>window.events=[];document.addEventListener('click',e=>window.events.push({target:e.target.tagName,trusted:e.isTrusted}))</script>`,
      );
      const cdp = await page.context().newCDPSession(page);
      const node = await isolatedNode(cdp, "#target");
      await page
        .locator("#target")
        .evaluate((el) => ((el as HTMLButtonElement).disabled = true));
      assert.equal(await targetPoint(cdp, node), null);
      await page
        .locator("#target")
        .evaluate((el) => ((el as HTMLButtonElement).disabled = false));
      const point = await targetPoint(cdp, node);
      assert(point);
      await mouse(cdp, point);
      assert.deepEqual(await page.evaluate(() => (window as any).events), [
        { target: "SPAN", trusted: true },
      ]);
      await page.evaluate(() => {
        const blocker = document.createElement("div");
        blocker.id = "cover";
        blocker.style = "position:fixed;inset:0;z-index:999";
        document.body.append(blocker);
      });
      assert.equal(await targetPoint(cdp, node), null);
      await page.locator("#cover").evaluate((el) => el.remove());
      await page
        .locator("#target")
        .evaluate((el) => el.replaceWith(el.cloneNode(true)));
      assert.equal(await targetPoint(cdp, node), null);
      assert.equal(
        (await page.evaluate(() => (window as any).events)).length,
        1,
      );
      await cdp.send("Runtime.releaseObjectGroup", { objectGroup: "probe" });
      await cdp.detach();
    } finally {
      await browser.close();
    }
  },
);

test(
  "coordinate dispatch can hit a different node after validation and between mouse events",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<button id="old" style="width:160px;height:90px">Old</button><script>window.events=[];document.addEventListener('click',e=>window.events.push(e.target.id))</script>`,
      );
      const cdp = await page.context().newCDPSession(page);
      const node = await isolatedNode(cdp, "#old");
      const point = await targetPoint(cdp, node);
      assert(point);
      await page.evaluate(() => {
        const b = document.querySelector("#old")!;
        const replacement = b.cloneNode(true) as HTMLElement;
        replacement.id = "replacement";
        b.replaceWith(replacement);
      });
      await mouse(cdp, point);
      assert.deepEqual(await page.evaluate(() => (window as any).events), [
        "replacement",
      ]);
      await page.setContent(
        `<button id="old" style="width:160px;height:90px">Old</button><script>window.events=[];document.addEventListener('pointerdown',()=>{const old=document.querySelector('#old');if(old){const b=old.cloneNode(true);b.id='replacement';old.replaceWith(b)}},true);document.addEventListener('pointerup',e=>window.events.push('up:'+e.target.id));document.addEventListener('click',e=>window.events.push('click:'+e.target.id))</script>`,
      );
      const next = await isolatedNode(cdp, "#old");
      const p = await targetPoint(cdp, next);
      assert(p);
      await mouse(cdp, p);
      const events = await page.evaluate(() => (window as any).events);
      assert.deepEqual(events, ["up:replacement"]);
      assert.equal(await page.locator("#replacement").count(), 1);
      await cdp.detach();
    } finally {
      await browser.close();
    }
  },
);
