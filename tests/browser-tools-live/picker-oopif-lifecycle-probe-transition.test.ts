import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";

test(
  "released gate during same-process to paused OOPIF navigation",
  { timeout: 30000, skip: process.env.BROWSER_HEADED !== "1" },
  async () => {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      if (req.url === "/old" || req.url === "/new")
        res.end(
          `<button style="width:180px;height:100px">Child</button><script>window.clicks=0;document.addEventListener('click',()=>{window.clicks++;parent.postMessage('activated','*')})</script>`,
        );
      else
        res.end(
          `<iframe src="/old" style="width:240px;height:160px"></iframe><script>window.activations=0;addEventListener('message',e=>{if(e.data==='activated')window.activations++})</script>`,
        );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const browser = await chromium.launch({
      headless: false,
      args: ["--site-per-process"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.frameLocator("iframe").getByRole("button").waitFor();
      const box = await page
        .frameLocator("iframe")
        .getByRole("button")
        .boundingBox();
      assert(box);
      const root = await page.context().newCDPSession(page);
      await root.send("DOM.enable");
      await root.send("Overlay.enable");
      await root.send("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: { showInfo: true },
      });
      let id = 0;
      const pending = new Map<
        number,
        { resolve: (v: any) => void; reject: (e: Error) => void }
      >();
      const selections: number[] = [];
      root.on("Target.receivedMessageFromTarget", ({ message }) => {
        const m = JSON.parse(message);
        if (m.id && pending.has(m.id)) {
          const p = pending.get(m.id)!;
          pending.delete(m.id);
          m.error
            ? p.reject(new Error(JSON.stringify(m.error)))
            : p.resolve(m.result);
        }
        if (m.method === "Overlay.inspectNodeRequested")
          selections.push(m.params.backendNodeId);
      });
      const send = async (
        sessionId: string,
        method: string,
        params: object = {},
      ) => {
        const n = ++id;
        const result = new Promise((resolve, reject) =>
          pending.set(n, { resolve, reject }),
        );
        await root.send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id: n, method, params }),
        });
        return await result;
      };
      const attached = new Promise<any>((resolve) =>
        root.on("Target.attachedToTarget", resolve),
      );
      await root.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: false,
      });
      await page.evaluate((url) => {
        (document.querySelector("iframe") as HTMLIFrameElement).src = url;
      }, `http://localhost:${port}/new`);
      const target = await attached;
      assert.equal(target.targetInfo.type, "iframe");
      assert.equal(target.waitingForDebugger, true);
      // Gate remains released: click while new renderer is paused and before inspect is armed.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => (window as any).activations), 0);
      // Deliberately fail one protocol command; suppress input before any recovery or resume.
      await assert.rejects(
        send(target.sessionId, "Overlay.thisMethodDoesNotExist"),
      );
      await root.send("Input.setIgnoreInputEvents", { ignore: true });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => (window as any).activations), 0);
      await send(target.sessionId, "DOM.enable");
      await send(target.sessionId, "Overlay.enable");
      await send(target.sessionId, "Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: { showInfo: true },
      });
      await send(target.sessionId, "Runtime.runIfWaitingForDebugger");
      const button = page.frameLocator("iframe").getByRole("button");
      await button.waitFor({ timeout: 5000 });
      await root.send("Input.setIgnoreInputEvents", { ignore: false });
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(100);
      assert.equal(selections.length, 1);
      assert.equal(await page.evaluate(() => (window as any).activations), 0);
      const frame = page.frames().find((f) => f.url().includes("/new"));
      assert(frame);
      assert.equal(await frame.evaluate(() => (window as any).clicks), 0);
      // On uncertainty, retain the input gate while disabling inspect and releasing paused targets.
      await root.send("Input.setIgnoreInputEvents", { ignore: true });
      await send(target.sessionId, "Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: {},
      });
      await root.send("Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: {},
      });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(100);
      assert.equal(await frame.evaluate(() => (window as any).clicks), 0);
      await root.send("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: false,
      });
      await root.send("Input.setIgnoreInputEvents", { ignore: false });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      assert.equal(await frame.evaluate(() => (window as any).clicks), 1);
      await root.detach();
    } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
