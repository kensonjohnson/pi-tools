import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { SemanticSnapshots } from "../../extensions/browser-tools/semantic-snapshots.ts";

test(
  "nested cross-origin frames, frame lifecycle and visual coverage",
  { timeout: 30000 },
  async () => {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      const port = (server.address() as any).port;
      if (req.url === "/child")
        res.end(
          `<button>Child</button><iframe src="http://127.0.0.1:${port}/nested"></iframe>`,
        );
      else if (req.url === "/nested") res.end("<button>Nested</button>");
      else
        res.end(
          `<button>Main</button><div id="frame-container"><iframe src="http://localhost:${port}/child"></iframe></div><div id="open"></div><div id="closed"></div><canvas></canvas><script>document.getElementById('open').attachShadow({mode:'open'}).innerHTML='<button>Open</button>';document.getElementById('closed').attachShadow({mode:'closed'}).innerHTML='<button>Closed</button>'</script>`,
        );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const browser = await chromium.launch({
      headless: true,
      args: ["--site-per-process"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
      await page
        .frameLocator("#frame-container iframe")
        .frameLocator("iframe")
        .getByRole("button", { name: "Nested" })
        .waitFor();
      const cdp = await page.context().newCDPSession(page);
      const targets = await cdp.send("Target.getTargets");
      assert(
        targets.targetInfos.some(
          (t) => t.type === "iframe" && t.url.includes("/child"),
        ),
        "cross-origin iframe should be out-of-process",
      );
      const snapshots = new SemanticSnapshots(page);
      const result = await snapshots.snapshot();
      for (const name of ["Main", "Child", "Nested", "Open"])
        assert(
          result.records.some((r) => r.name === name),
          name,
        );
      assert(!result.records.some((r) => r.name === "Closed"));
      assert(result.omitted.some((s) => /Closed shadow/.test(s)));
      assert(result.omitted.some((s) => /Canvas/.test(s)));
      const childRef = result.records.find((r) => r.name === "Child")!.ref!;
      await page.evaluate(() =>
        document.body.append(document.createElement("div")),
      );
      assert(await snapshots.resolve(childRef));
      await page
        .locator("#frame-container")
        .evaluate((el) => ((el as HTMLElement).style.display = "none"));
      await assert.rejects(snapshots.resolve(childRef), /Stale/);
      const hidden = await snapshots.snapshot();
      assert(
        !hidden.records.some((r) => r.name === "Child" || r.name === "Nested"),
      );
      assert(hidden.omitted.some((s) => /hidden frame/.test(s)));
      await page
        .locator("#frame-container")
        .evaluate((el) => ((el as HTMLElement).style.display = ""));
      const childFrame = page
        .frames()
        .find((frame) => frame.url().includes("/child"));
      assert(childFrame);
      const scopedFrame = await snapshots.snapshot({
        frame: childFrame,
        selector: "button",
      });
      assert(scopedFrame.records.some((r) => r.name === "Child"));
      assert(
        !scopedFrame.records.some(
          (r) => r.name === "Main" || r.name === "Nested",
        ),
      );
      const again = await snapshots.snapshot();
      const nested = again.records.find((r) => r.name === "Nested")!.ref!;
      await page
        .locator("#frame-container iframe")
        .evaluate((el) => el.remove());
      await assert.rejects(snapshots.resolve(nested), /Stale/);
      await snapshots.dispose();
      await cdp.detach();
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "long metadata and loaded offscreen forms remain bounded without scrolling",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(
        `data:text/html,${encodeURIComponent(`<title>${"🦊".repeat(500)}</title><div style="height:4000px"></div><section id="target"><h1>Detail</h1><input aria-label="Ordinary" value="hello"><input type="password" aria-label="Password" value="secret-password"><input type="hidden" value="secret-hidden"><p>Loaded offscreen</p></section>`)}`,
      );
      const snapshots = new SemanticSnapshots(page);
      const before = await page.evaluate(() => window.scrollY);
      await assert.rejects(
        snapshots.snapshot({ maxChars: 100 }),
        /at least 512 bytes/,
      );
      const scoped = await snapshots.snapshot({
        selector: "#target",
        maxChars: 1000,
      });
      assert(Buffer.byteLength(JSON.stringify(scoped)) <= 1000);
      assert(scoped.records.some((r) => r.name === "Loaded offscreen"));
      assert.equal(
        scoped.records.find((r) => r.name === "Ordinary")?.value,
        "hello",
      );
      assert(!JSON.stringify(scoped).includes("secret-password"));
      assert(!JSON.stringify(scoped).includes("secret-hidden"));
      assert.equal(await page.evaluate(() => window.scrollY), before);
      await snapshots.dispose();
    } finally {
      await browser.close();
    }
  },
);
