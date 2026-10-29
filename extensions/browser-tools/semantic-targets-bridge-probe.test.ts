import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

test(
  "fresh iframe intrinsic event bridge transfers an isolated node but can be spoofed when realm bootstrap is patched",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    try {
      const page = await browser.newPage();
      for (const hostile of [false, true]) {
        await page.setContent(
          `<button id="exact">Exact</button><button id="other">Other</button>${
            hostile
              ? `<script>
    const append=Node.prototype.appendChild;
    Node.prototype.appendChild=function(n){const result=append.call(this,n);if(n.tagName==='IFRAME'){
      const proto=n.contentWindow.EventTarget.prototype;const add=proto.addEventListener;
      proto.addEventListener=function(type,listener,options){window.stolen=type;queueMicrotask(()=>document.querySelector('#other').dispatchEvent(new Event(type,{bubbles:true,composed:true})));return add.call(this,type,listener,options)};
    }return result};
   </script>`
              : ""
          }`,
        );
        const cdp = await page.context().newCDPSession(page);
        const tree = await cdp.send("Page.getFrameTree");
        const ctx = await cdp.send("Page.createIsolatedWorld", {
          frameId: tree.frameTree.frame.id,
          worldName: "event-bridge",
        });
        const exact = await cdp.send("Runtime.evaluate", {
          contextId: ctx.executionContextId,
          expression: `document.querySelector('#exact')`,
        });
        assert(exact.result.objectId);
        const eventName = "semantic_" + randomUUID().replaceAll("-", "");
        const setup = await page.evaluateHandle((name) => {
          const iframe = document.createElement("iframe");
          document.documentElement.appendChild(iframe);
          const realm = iframe.contentWindow!;
          const add = realm.EventTarget.prototype.addEventListener;
          const path = realm.Event.prototype.composedPath;
          let resolve!: (node: EventTarget) => void;
          const promise = new Promise<EventTarget>((r) => (resolve = r));
          add.call(
            window,
            name,
            (event: Event) => resolve(path.call(event)[0]),
            { capture: true, once: true },
          );
          iframe.remove();
          return { promise };
        }, eventName);
        const props = await setup.getProperties();
        const promise = props.get("promise");
        assert(promise);
        const resolved = promise.evaluateHandle(async (p) => await p);
        const delivery = await cdp.send("Runtime.callFunctionOn", {
          objectId: exact.result.objectId,
          functionDeclaration:
            "function(n){return this.dispatchEvent(new Event(n,{bubbles:true,composed:true}))}",
          arguments: [{ value: eventName }],
          returnByValue: true,
        });
        assert.equal(delivery.result.value, true);
        const handle = (await resolved).asElement();
        assert(handle);
        assert.equal(
          await handle.getAttribute("id"),
          hostile ? "other" : "exact",
        );
        if (hostile)
          assert.equal(
            await page.evaluate(() => (window as any).stolen),
            eventName,
          );
        await handle.dispose();
        await promise.dispose();
        await setup.dispose();
        await cdp.detach();
      }
    } finally {
      await browser.close();
    }
  },
);
