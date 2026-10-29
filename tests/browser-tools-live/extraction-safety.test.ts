import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { extractPage } from "../../extensions/browser-tools/extraction.ts";

test("isolated extraction does not invoke page overrides or custom element constructors", async () => {
  const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<title>Fixture</title><x-widget><p id="scope">Safe content <a href="https://user:password@example.test/?token=secret%23private">link</a><img src="https://example.test/image?token=imgsecret"></p></x-widget>',
    );
    await page.evaluate(() => {
      (window as any).constructorCalls = 0;
      (window as any).overrides = 0;
      customElements.define(
        "x-widget",
        class extends HTMLElement {
          constructor() {
            super();
            (window as any).constructorCalls++;
          }
        },
      );
      Node.prototype.cloneNode = function () {
        (window as any).overrides++;
        throw new Error("clone override");
      };
      Element.prototype.matches = function () {
        (window as any).overrides++;
        throw new Error("matches override");
      };
      Element.prototype.getAttribute = function () {
        (window as any).overrides++;
        throw new Error("attribute override");
      };
      window.getComputedStyle = function () {
        (window as any).overrides++;
        throw new Error("style override");
      } as any;
    });
    const before = await page.evaluate(() => (window as any).constructorCalls);
    const result = await extractPage(
      page,
      { selector: "#scope" },
      "https://name:pass@example.test/?code=secret#fragment",
    );
    assert.equal(
      await page.evaluate(() => (window as any).constructorCalls),
      before,
    );
    assert.equal(await page.evaluate(() => (window as any).overrides), 0);
    assert.match(result.text, /Safe content/);
    assert.doesNotMatch(
      JSON.stringify(result),
      /password|imgsecret|token=secret|code=secret|name:pass|#fragment/,
    );
    assert.match(result.omissions, /images/);
  } finally {
    await browser.close();
  }
});

test("oversized text, wide trees, and overly deep trees fail without partial output", async () => {
  const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.goto("data:text/html,<title>Limits</title><main></main>");
    await page.evaluate(() => {
      document.querySelector("main")!.textContent = "é".repeat(300000);
    });
    await assert.rejects(extractPage(page), /text limit exceeded/);
    await page.evaluate(() => {
      document.querySelector("main")!.innerHTML = "<p>x</p>".repeat(5000);
    });
    await assert.rejects(extractPage(page), /node limit exceeded/);
    await page.evaluate(() => {
      const main = document.querySelector("main")!;
      main.innerHTML = "";
      let node = main;
      for (let i = 0; i < 150; i++) {
        const child = document.createElement("div");
        node.appendChild(child);
        node = child;
      }
      node.textContent = "deep";
    });
    await assert.rejects(extractPage(page), /depth limit exceeded/);
  } finally {
    await browser.close();
  }
});
