import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";

test(
  "OOPIF node box and hit test coordinates require target-specific mapping",
  { timeout: 30000 },
  async () => {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        req.url === "/child"
          ? `<button id="b" style="width:120px;height:80px">Child</button><script>window.events=[];document.addEventListener('click',e=>window.events.push(e.isTrusted))</script>`
          : `<div style="height:140px"></div><iframe style="margin-left:100px;width:300px;height:150px" src="http://localhost:${(server.address() as any).port}/child"></iframe>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
      args: ["--site-per-process"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
      await page.frameLocator("iframe").getByRole("button").waitFor();
      const root = await page.context().newCDPSession(page);
      const targets = await root.send("Target.getTargets");
      assert(
        targets.targetInfos.some(
          (t) => t.type === "iframe" && t.url.includes("/child"),
        ),
      );
      const frame = page.frames().find((f) => f.url().includes("/child"));
      assert(frame);
      const child = await page.context().newCDPSession(frame);
      await child.send("DOM.enable");
      const tree = await child.send("Page.getFrameTree");
      const ctx = await child.send("Page.createIsolatedWorld", {
        frameId: tree.frameTree.frame.id,
        worldName: "probe",
      });
      const r = await child.send("Runtime.evaluate", {
        contextId: ctx.executionContextId,
        expression: 'document.querySelector("#b")',
      });
      assert(r.result.objectId);
      const box = await child.send("DOM.getBoxModel", {
        objectId: r.result.objectId,
      });
      const q = box.model.content;
      const x = Math.floor((q[0] + q[2] + q[4] + q[6]) / 4),
        y = Math.floor((q[1] + q[3] + q[5] + q[7]) / 4);
      const pwBox = await page
        .frameLocator("iframe")
        .getByRole("button")
        .boundingBox();
      assert(pwBox);
      const hit = await child
        .send("DOM.getNodeForLocation", { x, y })
        .catch(() => null);
      assert(hit?.backendNodeId);
      assert.notEqual(x, Math.floor(pwBox.x + pwBox.width / 2));
      assert.notEqual(y, Math.floor(pwBox.y + pwBox.height / 2));
      await child.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
      });
      await child.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await child.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      assert.deepEqual(await frame.evaluate(() => (window as any).events), [
        true,
      ]);
      await page.frameLocator("iframe").getByRole("button").click();
      assert.deepEqual(await frame.evaluate(() => (window as any).events), [
        true,
        true,
      ]);
      await page.evaluate(() => {
        const cover = document.createElement("div");
        cover.style = "position:fixed;inset:0;z-index:999";
        document.body.append(cover);
      });
      const childHit = await child.send("DOM.getNodeForLocation", { x, y });
      assert(childHit.backendNodeId);
      await child.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await child.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      assert.deepEqual(await frame.evaluate(() => (window as any).events), [
        true,
        true,
        true,
      ]);
      await assert.rejects(
        page.frameLocator("iframe").getByRole("button").click({ timeout: 600 }),
      );
      assert.deepEqual(await frame.evaluate(() => (window as any).events), [
        true,
        true,
        true,
      ]);
      await child.detach();
      await root.detach();
    } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
