import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

test(
  "macOS CGEvent mouse clicks on root and OOPIF under input gate and inspect",
  {
    timeout: 60000,
    skip: process.platform !== "darwin" || process.env.BROWSER_HEADED !== "1",
  },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "picker-os-input-"));
    const source = join(dir, "click.swift"),
      bin = join(dir, "click");
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      const port = (server.address() as any).port;
      res.end(
        req.url === "/child"
          ? `<button style="width:180px;height:100px">Child</button><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++)</script>`
          : `<button id="root" style="width:180px;height:100px">Root</button><iframe src="http://localhost:${port}/child" style="width:240px;height:160px"></iframe><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++)</script>`,
      );
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await writeFile(
        source,
        `import Foundation\nimport CoreGraphics\nlet a = CommandLine.arguments\nif a.count == 2 { print(CGPreflightPostEventAccess() ? "allowed" : "denied"); exit(0) }\nlet p = CGPoint(x: Double(a[1])!, y: Double(a[2])!)\nfor type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {\n guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left) else { exit(2) }\n e.post(tap: .cghidEventTap); usleep(100000)\n}\n`,
      );
      execFileSync("swiftc", [source, "-o", bin], {
        timeout: 30000,
        stdio: "pipe",
      });
      const permission = execFileSync(bin, ["check"], {
        timeout: 5000,
        encoding: "utf8",
      }).trim();
      console.log("CGPreflightPostEventAccess:", permission);
      if (permission !== "allowed") {
        t.skip("macOS denies CGEvent posting; no permissions were requested");
        return;
      }
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as any).port;
      browser = await chromium.launch({
        headless: false,
        args: [
          "--site-per-process",
          "--window-position=50,50",
          "--window-size=1000,700",
        ],
      });
      const page = await browser.newPage({ viewport: null });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.bringToFront();
      const childButton = page.frameLocator("iframe").getByRole("button");
      await childButton.waitFor();
      const frame = page.frames().find((f) => f.url().includes("/child"));
      assert(frame);
      const rootButton = page.locator("#root");
      const screen = await page.evaluate(() => ({
        x: window.screenX,
        y: window.screenY,
        dx: (window.outerWidth - window.innerWidth) / 2,
        dy: window.outerHeight - window.innerHeight,
        focus: document.hasFocus(),
        deviceScale: window.devicePixelRatio,
      }));
      console.log("window geometry:", screen);
      assert(screen.focus, "fixture window must be focused");
      const post = async (locator: typeof rootButton) => {
        const box = await locator.boundingBox();
        assert(box);
        const x = Math.round(screen.x + screen.dx + box.x + box.width / 2),
          y = Math.round(screen.y + screen.dy + box.y + box.height / 2);
        console.log("OS click screen point:", x, y);
        execFileSync(bin, [String(x), String(y)], { timeout: 5000 });
        await page.waitForTimeout(200);
      };
      await post(rootButton);
      const baseline = await page.evaluate(() => (window as any).clicks);
      console.log("ungated root baseline:", baseline);
      if (baseline !== 1) {
        t.skip(
          "OS event did not reach mapped root button; permission, focus or screen geometry unverified",
        );
        return;
      }
      await post(childButton);
      assert.equal(
        await frame.evaluate(() => (window as any).clicks),
        1,
        "ungated child must receive OS click",
      );
      const root = await page.context().newCDPSession(page);
      await root.send("Input.setIgnoreInputEvents", { ignore: true });
      await post(rootButton);
      await post(childButton);
      assert.equal(await page.evaluate(() => (window as any).clicks), 1);
      assert.equal(await frame.evaluate(() => (window as any).clicks), 1);
      await root.send("DOM.enable");
      await root.send("Overlay.enable");
      await root.send("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: { showInfo: true },
      });
      const child = await page.context().newCDPSession(frame);
      await child.send("DOM.enable");
      await child.send("Overlay.enable");
      const seen: number[] = [];
      child.on("Overlay.inspectNodeRequested", (e) =>
        seen.push(e.backendNodeId),
      );
      await child.send("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: { showInfo: true },
      });
      await root.send("Input.setIgnoreInputEvents", { ignore: false });
      await post(childButton);
      assert.equal(seen.length, 1);
      assert.equal(await frame.evaluate(() => (window as any).clicks), 1);
      await root.send("Input.setIgnoreInputEvents", { ignore: true });
      await child.send("Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: {},
      });
      await root.send("Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: {},
      });
      await root.send("Input.setIgnoreInputEvents", { ignore: false });
      await post(childButton);
      assert.equal(await frame.evaluate(() => (window as any).clicks), 2);
      await child.detach();
      await root.detach();
    } finally {
      if (browser) await browser.close();
      if (server.listening)
        await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
