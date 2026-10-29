import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";

test(
  "OOPIF accessibility requires its own target session",
  { timeout: 30000 },
  async () => {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        req.url === "/child"
          ? "<button>Cross site</button><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++)</script>"
          : `<iframe src="http://localhost:${(server.address() as any).port}/child"></iframe>`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as any).port;
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
      args: ["--site-per-process"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.frameLocator("iframe").getByRole("button").waitFor();
      const cdp = await page.context().newCDPSession(page);
      const targets = await cdp.send("Target.getTargets");
      const iframe = targets.targetInfos.find(
        (t) => t.type === "iframe" && t.url.includes("/child"),
      );
      assert(iframe, "fixture must really produce an OOPIF");
      const result = await cdp
        .send("Accessibility.getFullAXTree", { frameId: iframe.targetId })
        .catch(() => null);
      const found =
        result?.nodes.some(
          (n) => n.name?.value === "Cross site" && n.role?.value === "button",
        ) ?? false;
      assert.equal(found, false);
      const frame = page.frames().find((f) => f.url().includes("/child"));
      assert(frame);
      const frameCdp = await page.context().newCDPSession(frame);
      const tree = await frameCdp.send("Accessibility.getFullAXTree");
      const button = tree.nodes.find(
        (n) => n.name?.value === "Cross site" && n.role?.value === "button",
      );
      assert(button?.backendDOMNodeId);
      assert.equal(
        (
          await frameCdp.send("DOM.describeNode", {
            backendNodeId: button.backendDOMNodeId,
          })
        ).node.nodeName,
        "BUTTON",
      );
      if (process.env.BROWSER_HEADED === "1") {
        await cdp.send("DOM.enable");
        await cdp.send("Overlay.enable");
        const seen: number[] = [];
        cdp.on("Overlay.inspectNodeRequested", (event) =>
          seen.push(event.backendNodeId),
        );
        await cdp.send("Overlay.setInspectMode", {
          mode: "searchForNode",
          highlightConfig: { showInfo: true },
        });
        const box = await page
          .frameLocator("iframe")
          .getByRole("button")
          .boundingBox();
        assert(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(200);
        assert.equal(seen.length, 0);
        assert.equal(await frame.evaluate(() => (window as any).clicks), 1);
        await cdp.send("Overlay.setInspectMode", {
          mode: "none",
          highlightConfig: {},
        });
        await frameCdp.send("DOM.enable");
        await frameCdp.send("Overlay.enable");
        const childSeen: number[] = [];
        frameCdp.on("Overlay.inspectNodeRequested", (event) =>
          childSeen.push(event.backendNodeId),
        );
        await cdp.send("Overlay.setInspectMode", {
          mode: "searchForNode",
          highlightConfig: { showInfo: true },
        });
        await frameCdp.send("Overlay.setInspectMode", {
          mode: "searchForNode",
          highlightConfig: { showInfo: true },
        });
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(200);
        assert.equal(childSeen.length, 1);
        assert.equal(
          (
            await frameCdp.send("DOM.describeNode", {
              backendNodeId: childSeen[0],
            })
          ).node.nodeName,
          "BUTTON",
        );
        assert.equal(await frame.evaluate(() => (window as any).clicks), 1);
        await frameCdp.send("Overlay.setInspectMode", {
          mode: "none",
          highlightConfig: {},
        });
        await cdp.send("Overlay.setInspectMode", {
          mode: "none",
          highlightConfig: {},
        });
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        assert.equal(await frame.evaluate(() => (window as any).clicks), 2);
      }
      await frameCdp.detach();
      await cdp.detach();
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
