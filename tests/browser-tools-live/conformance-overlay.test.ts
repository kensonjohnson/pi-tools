import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

test(
  "owned capture-phase multi-picker demonstrator retains nodes and removes listeners on cancellation",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<button id="a">A</button><a id="b" href="#activated">B</a><div id="host"></div><script>window.activations=0;document.addEventListener('click',()=>window.activations++);host.attachShadow({mode:'open'}).innerHTML='<button id="shadow">S</button>'</script>`,
      );
      // Demonstrates the owned-picker mechanism only, not a production overlay. No style changes.
      const picker = await page.evaluateHandle(() => {
        const selected: Element[] = [];
        let cancelled = false;
        const onClick = (event: MouseEvent) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          const node = event
            .composedPath()
            .find((item): item is Element => item instanceof Element);
          if (node && !selected.includes(node)) selected.push(node);
        };
        const dispose = () => {
          document.removeEventListener("click", onClick, true);
          document.removeEventListener("keydown", onKey, true);
        };
        const cancel = () => {
          cancelled = true;
          selected.length = 0;
          dispose();
        };
        const onKey = (event: KeyboardEvent) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopImmediatePropagation();
            cancel();
          }
        };
        document.addEventListener("click", onClick, true);
        document.addEventListener("keydown", onKey, true);
        return { selected, cancel, dispose, isCancelled: () => cancelled };
      });
      await page.locator("#a").click();
      await page.locator("#b").click();
      await page.locator("#shadow").click();
      assert.equal(await page.evaluate(() => (window as any).activations), 0);
      assert.equal(await page.evaluate(() => location.hash), "");
      assert.deepEqual(
        await picker.evaluate((p) => p.selected.map((el) => el.id)),
        ["a", "b", "shadow"],
      );
      const selected = (await picker.getProperties()).get("selected")!;
      const node = (await selected.getProperties()).get("0")!.asElement();
      assert(node);
      await page
        .locator("#a")
        .evaluate((el) => el.replaceWith(el.cloneNode(true)));
      assert.equal(await node.evaluate((el) => el.isConnected), false);
      await assert.rejects(node.click({ timeout: 500 }));
      await page.keyboard.press("Escape");
      assert.equal(await picker.evaluate((p) => p.isCancelled()), true);
      assert.equal(await picker.evaluate((p) => p.selected.length), 0);
      await page.locator("#b").click();
      assert.equal(await page.evaluate(() => location.hash), "#activated");
      await node.dispose();
      await selected.dispose();
      await picker.dispose();
      // An abort path calls the owned cancel function, then ordinary page input is restored.
      const abortPicker = await page.evaluateHandle(() => {
        const consume = (e: MouseEvent) => {
          e.preventDefault();
          e.stopImmediatePropagation();
        };
        document.addEventListener("click", consume, true);
        return {
          cancel: () => document.removeEventListener("click", consume, true),
        };
      });
      const controller = new AbortController();
      const cancelled = new Promise<void>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      controller.abort();
      await cancelled;
      await abortPicker.evaluate((p) => p.cancel());
      await page.locator("#shadow").click();
      assert.equal(await page.evaluate(() => (window as any).activations), 2);
      const oldNode = await page.locator("#shadow").elementHandle();
      assert(oldNode);
      await page.goto(
        'data:text/html,<button id="shadow">replacement</button>',
      );
      await assert.rejects(oldNode.click({ timeout: 500 }));
      await oldNode.dispose();
      await abortPicker.dispose();
    } finally {
      await browser.close();
    }
  },
);
