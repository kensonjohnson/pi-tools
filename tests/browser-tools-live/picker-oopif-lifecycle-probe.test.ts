import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";

test(
  "prearm dynamically attached OOPIF through public CDP target routing",
  { timeout: 30000, skip: process.env.BROWSER_HEADED !== "1" },
  async () => {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        req.url?.startsWith("/child")
          ? `<button style="width:180px;height:100px">Child</button><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++)</script>`
          : `<div id="host"></div>`,
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
      const sessions: string[] = [];
      const failures: string[] = [];
      root.on("Target.receivedMessageFromTarget", ({ message }) => {
        const msg = JSON.parse(message);
        if (msg.id && pending.has(msg.id)) {
          const waiter = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
          else waiter.resolve(msg.result);
        }
        if (msg.method === "Overlay.inspectNodeRequested")
          selections.push(msg.params.backendNodeId);
      });
      const send = async (
        sessionId: string,
        method: string,
        params: object = {},
      ) => {
        const n = ++id;
        const response = new Promise((resolve, reject) =>
          pending.set(n, { resolve, reject }),
        );
        await root.send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id: n, method, params }),
        });
        return await response;
      };
      const armed: Promise<void>[] = [];
      root.on("Target.attachedToTarget", (event) => {
        if (event.targetInfo.type !== "iframe") return;
        sessions.push(event.sessionId);
        armed.push(
          (async () => {
            try {
              assert.equal(event.waitingForDebugger, true);
              await send(event.sessionId, "DOM.enable");
              await send(event.sessionId, "Overlay.enable");
              await send(event.sessionId, "Overlay.setInspectMode", {
                mode: "searchForNode",
                highlightConfig: { showInfo: true },
              });
            } catch (error) {
              failures.push(String(error));
            } finally {
              await send(
                event.sessionId,
                "Runtime.runIfWaitingForDebugger",
              ).catch((e) => failures.push(String(e)));
            }
          })(),
        );
      });
      await root.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: false,
      });
      await page.evaluate((url) => {
        const f = document.createElement("iframe");
        f.src = url;
        document.querySelector("#host")!.append(f);
      }, `http://localhost:${port}/child`);
      const button = page.frameLocator("iframe").getByRole("button");
      await button.waitFor({ timeout: 5000 });
      await Promise.all(armed);
      assert.equal(failures.length, 0, failures.join("; "));
      assert.equal(sessions.length, 1);
      const frame = page.frames().find((f) => f.url().includes("/child"));
      assert(frame);
      const box = await button.boundingBox();
      assert(box);
      for (let i = 0; i < 2; i++) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(100);
      }
      assert.equal(selections.length, 2);
      assert.equal(await frame.evaluate(() => (window as any).clicks), 0);
      const described: any = await send(sessions[0], "DOM.describeNode", {
        backendNodeId: selections[0],
      });
      assert.equal(described.node.nodeName, "BUTTON");
      await send(sessions[0], "Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: {},
      });
      await root.send("Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: {},
      });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      assert.equal(await frame.evaluate(() => (window as any).clicks), 1);
      await root.send("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: false,
      });
      await root.detach();
    } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
