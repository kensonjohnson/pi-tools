import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { chromium } from "playwright";

test(
  "probe page CDP dialog event provenance across main, local and OOPIF frames",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        req.url === "/"
          ? `<iframe src='/frame'></iframe><iframe src='http://localhost:${(server.address() as any).port}/frame'></iframe>`
          : "<button>frame</button>",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    const browser = await chromium.launch({
      headless: true,
      args: ["--site-per-process"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.enable");
      const events: any[] = [];
      cdp.on("Page.javascriptDialogOpening", (v) =>
        events.push({ kind: "open", ...v }),
      );
      cdp.on("Page.javascriptDialogClosed", (v) =>
        events.push({ kind: "close", ...v }),
      );
      const dialogs: any[] = [];
      page.on("dialog", (dialog) => {
        events.push({
          kind: "playwright",
          message: dialog.message(),
          type: dialog.type(),
        });
        dialogs.push(dialog);
      });
      for (const [index, frame] of page.frames().entries()) {
        const before = events.length;
        const waiting = frame.evaluate((n) => confirm(`case-${n}`), index);
        for (let n = 0; n < 100 && dialogs.length <= index; n++)
          await new Promise((r) => setTimeout(r, 10));
        assert.ok(dialogs[index]);
        await dialogs[index].dismiss();
        assert.equal(await waiting, false);
        await new Promise((r) => setTimeout(r, 30));
        const captured = events.slice(before);
        const opening = captured.find((event) => event.kind === "open");
        const closing = captured.find((event) => event.kind === "close");
        assert.ok(opening && closing, `missing CDP events for frame ${index}`);
        assert.equal(opening.frameId, closing.frameId);
        assert.equal(opening.message, `case-${index}`);
      }
      page.removeAllListeners("dialog");
      events.length = 0;
      page.on("dialog", (dialog) => {
        events.push({
          kind: "playwright",
          message: dialog.message(),
          type: dialog.type(),
        });
        void dialog.dismiss();
      });
      await page.evaluate(() => {
        confirm("identical");
        confirm("identical");
      });
      await new Promise((r) => setTimeout(r, 30));
      const openings = events.filter((event) => event.kind === "open");
      const closings = events.filter((event) => event.kind === "close");
      assert.equal(openings.length, 2);
      assert.equal(closings.length, 2);
      assert.deepEqual(openings[0], openings[1]);
      assert.deepEqual(closings[0], closings[1]);
      await cdp.detach();
      page.removeAllListeners("dialog");
      let dialog: import("playwright").Dialog | undefined;
      page.on("dialog", (item) => {
        dialog = item;
      });
      const held = page.evaluate(() => confirm("already open"));
      for (let n = 0; n < 100 && !dialog; n++)
        await new Promise((r) => setTimeout(r, 10));
      assert.ok(dialog);
      const acquisition = page.context().newCDPSession(page);
      const late = await Promise.race([
        acquisition,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
      ]);
      if (late) {
        const lateEvents: unknown[] = [];
        late.on("Page.javascriptDialogOpening", (event) =>
          lateEvents.push(event),
        );
        const enable = late.send("Page.enable");
        await Promise.race([
          enable,
          new Promise<void>((resolve) => setTimeout(resolve, 200)),
        ]);
        assert.equal(
          lateEvents.length,
          0,
          "late monitor did not observe the existing opening",
        );
        await dialog.dismiss();
        assert.equal(await held, false);
        await enable.catch(() => {});
        await late.detach();
      } else {
        await dialog.dismiss();
        assert.equal(await held, false);
        await (await acquisition).detach();
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
