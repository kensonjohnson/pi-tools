import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";

test(
  "owned actions target exact controls and verify bounded outcomes without repeating submissions",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    let submissions = 0;
    const server = createServer((request, response) => {
      if (request.url === "/submit" || request.url === "/delayed") {
        submissions++;
        if (request.url === "/delayed")
          setTimeout(() => response.end("ok"), 350);
        else response.end("ok");
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(`<input id="input"><select id="select"><option value="a">A</option><option value="b">B</option></select>
      <button class="duplicate">Same</button><button class="duplicate">Same</button>
      <section id="scope"><button id="submit" onclick="fetch('/submit').then(()=>{document.querySelector('#result').textContent='Done'; history.pushState({},'', '/done')})">Submit</button></section><div id="result"></div>
      <button id="slow" onclick="fetch('/delayed')">Slow</button><button id="disabled" disabled>Wait</button>
      <button id="delayed-text" onclick="setTimeout(()=>document.querySelector('#result').textContent='Later', 100)">Delayed text</button>
      <button id="url" onclick="history.pushState({},'', '/instant')">URL</button>
      <iframe id="child" srcdoc="<button id='inside'>Child</button>"></iframe>`);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const sessions = new ManagedSessions({
      launch: ({ headless }) => chromium.launch({ headless }),
    });
    try {
      const page = await sessions.start({
        headless: true,
        artifactOwner: "owner",
      });
      await sessions.navigate(
        `http://127.0.0.1:${address.port}/`,
        page,
        undefined,
        30000,
        "owner",
      );
      let hooks = 0,
        cleanups = 0;
      const removeHook = sessions.onActionPending(() => {
        hooks++;
        return () => {
          cleanups++;
        };
      });
      const listenerBaseline = await sessions.withOwnedPage(
        page,
        undefined,
        "owner",
        async (p) => ({
          responses: p.listenerCount("response"),
          navigations: p.listenerCount("framenavigated"),
        }),
      );
      const action = (
        args: Parameters<typeof sessions.action>[2],
        owner = "owner",
        signal?: AbortSignal,
      ) => sessions.action(page, owner, args, signal);
      await assert.rejects(
        action({ action: "click", target: { selector: ".duplicate" } }),
        /matched 2/,
      );
      await assert.rejects(
        action({ action: "click", target: { selector: "#submit" } }, "foreign"),
        /Session unavailable/,
      );
      assert.equal(
        (
          await action({
            action: "fill",
            target: { selector: "#input" },
            value: "hello",
          })
        ).verification,
        "no_expectation",
      );
      await action({
        action: "press",
        target: { selector: "#input" },
        value: "End",
      });
      await action({
        action: "select",
        target: { selector: "#select" },
        value: "b",
      });
      await action({ action: "scroll", target: { selector: "#submit" } });
      await action({
        action: "wait",
        target: { selector: "#inside", frameSelector: "#child" },
      });
      const response = await action({
        action: "click",
        target: { role: "button", name: "Submit", scopeSelector: "#scope" },
        expect: { kind: "response", value: "/submit", status: 200 },
      });
      assert.equal(response.status, "completed");
      assert.equal(response.verification, "verified_condition");
      assert.equal(submissions, 1);
      assert.equal(
        (
          await action({
            action: "wait",
            target: { selector: "#result" },
            expect: { kind: "text", value: "Done" },
          })
        ).verification,
        "verified_condition",
      );
      assert.equal(
        (
          await action({
            action: "wait",
            target: { selector: "#result" },
            expect: { kind: "url", value: "/done" },
          })
        ).verification,
        "verified_condition",
      );
      const delayedText = await action({
        action: "click",
        target: { selector: "#delayed-text" },
        timeoutMs: 1000,
        expect: { kind: "text", value: "Later" },
      });
      assert.equal(delayedText.verification, "verified_condition");
      const fastUrl = await action({
        action: "click",
        target: { selector: "#url" },
        expect: { kind: "url", value: "/instant" },
      });
      assert.equal(fastUrl.verification, "verified_condition");
      const slow = await action({
        action: "click",
        target: { selector: "#slow" },
        timeoutMs: 200,
        expect: { kind: "text", value: "Never comes" },
      });
      assert.equal(slow.verification, "unconfirmed");
      assert.equal(submissions, 2);
      const listenerAfter = await sessions.withOwnedPage(
        page,
        undefined,
        "owner",
        async (p) => ({
          responses: p.listenerCount("response"),
          navigations: p.listenerCount("framenavigated"),
        }),
      );
      assert.deepEqual(listenerAfter, listenerBaseline);
      assert.equal(hooks, cleanups);
      removeHook();
      const snapshot = await sessions.snapshot(page, "owner", undefined, {
        selector: "#slow",
      });
      const ref = snapshot.snapshot.records.find((item) => item.ref)?.ref;
      assert.ok(ref);
      await sessions.evaluate(
        "(() => { let e=document.querySelector('#slow'); e.replaceWith(e.cloneNode(true)) })()",
        page,
        undefined,
        "owner",
      );
      await assert.rejects(
        action({ action: "click", target: { ref } }),
        /Stale reference/,
      );
      const disabled = await action({
        action: "click",
        target: { selector: "#disabled" },
        timeoutMs: 100,
      });
      assert.equal(disabled.status, "possibly_dispatched");
      assert.equal(disabled.verification, "no_expectation");
      const early = new AbortController();
      early.abort();
      await assert.rejects(
        action(
          { action: "click", target: { selector: "#slow" } },
          "owner",
          early.signal,
        ),
        /cancelled before dispatch/,
      );
      assert.equal(submissions, 2);
      const abort = new AbortController();
      const pending = action(
        { action: "click", target: { selector: "#disabled" }, timeoutMs: 5000 },
        "owner",
        abort.signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await assert.rejects(
        action({ action: "click", target: { selector: "#slow" } }),
        /Session is busy/,
      );
      abort.abort();
      await assert.rejects(
        pending,
        /already dispatched action may have occurred/,
      );
      await assert.rejects(
        action({ action: "click", target: { selector: "#slow" } }),
        /Session unavailable/,
      );
    } finally {
      await sessions.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
