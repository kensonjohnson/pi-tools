import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

test(
  "retained handle click under hover-time replacement versus baseline and pre-detach",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    try {
      const page = await browser.newPage();
      const markup = (
        mutate: boolean,
      ) => `<button id="old" style="position:absolute;left:120px;top:120px;width:160px;height:90px">Old</button><script>
      window.events=[];window.swaps=0;
      for(const type of ['pointermove','mousemove','pointerdown','pointerup','click']) document.addEventListener(type,e=>window.events.push([type,e.target.id,e.isTrusted]),true);
      ${mutate ? `document.addEventListener('mousemove',e=>{const old=document.querySelector('#old');if(old){const clone=old.cloneNode(true);clone.id='replacement';old.replaceWith(clone);window.swaps++}}, {capture:true,once:true});` : ""}
    </script>`;
      await page.setContent(markup(false));
      let handle = await page.locator("#old").elementHandle();
      assert(handle);
      await handle.click({ timeout: 1500 });
      const baseline = await page.evaluate(() => (window as any).events);
      assert(
        baseline.some(
          (e: any) => e[0] === "click" && e[1] === "old" && e[2] === true,
        ),
      );
      await handle.dispose();
      await page.mouse.move(0, 0);
      await page.setContent(markup(true));
      handle = await page.locator("#old").elementHandle();
      assert(handle);
      const outcome = await handle.click({ timeout: 1500 }).then(
        () => "resolved",
        (e) => `rejected:${String(e)}`,
      );
      const events = await page.evaluate(() => (window as any).events);
      assert.match(outcome, /^rejected:.*not attached/s);
      assert.match(outcome, /performing click action/);
      assert.deepEqual(events, [
        ["pointermove", "old", true],
        ["mousemove", "old", true],
      ]);
      assert.equal(await page.evaluate(() => (window as any).swaps), 1);
      assert.equal(await handle.evaluate((el) => el.isConnected), false);
      await handle.dispose();
      await page.mouse.move(0, 0);
      await page.setContent(markup(false));
      handle = await page.locator("#old").elementHandle();
      assert(handle);
      await page
        .locator("#old")
        .evaluate((el) => el.replaceWith(el.cloneNode(true)));
      await assert.rejects(handle.click({ timeout: 500 }));
      assert.equal(
        (await page.evaluate(() => (window as any).events)).filter(
          (e: any) => e[0] === "click",
        ).length,
        0,
      );
      await handle.dispose();
    } finally {
      await browser.close();
    }
  },
);

test(
  "Playwright retained element can deliver pointerup to a replacement during dispatch",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<button id="old" style="width:160px;height:90px">Old</button><script>window.events=[];document.addEventListener('pointerdown',()=>{const old=document.querySelector('#old');if(old){const b=old.cloneNode(true);b.id='replacement';old.replaceWith(b)}},true);document.addEventListener('pointerup',e=>window.events.push(['up',e.target.id,e.isTrusted]));document.addEventListener('click',e=>window.events.push(['click',e.target.id,e.isTrusted]))</script>`,
      );
      const handle = await page.locator("#old").elementHandle();
      assert(handle);
      await handle.click({ timeout: 1000 }).catch(() => {});
      assert.deepEqual(await page.evaluate(() => (window as any).events), [
        ["up", "replacement", true],
      ]);
      assert.equal(await handle.evaluate((el) => el.isConnected), false);
      await handle.dispose();
    } finally {
      await browser.close();
    }
  },
);
