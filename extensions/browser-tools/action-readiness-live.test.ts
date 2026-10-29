import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";

test(
  "delayed targets share one deadline, reject simultaneous ambiguity, and cancel without dispatch",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const sessions = new ManagedSessions({
      launch: ({ headless }) => chromium.launch({ headless }),
    });
    try {
      const target = await sessions.start({
        headless: true,
        artifactOwner: "owner",
      });
      await sessions.navigate(
        "data:text/html,<body></body>",
        target,
        undefined,
        30000,
        "owner",
      );
      const evaluate = (source: string) =>
        sessions.evaluate(source, target, undefined, "owner");
      const action = (
        args: Parameters<typeof sessions.action>[2],
        signal?: AbortSignal,
      ) => sessions.action(target, "owner", args, signal);
      await evaluate(
        `(() => { window.clicks=0; setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<button id="late" onclick="window.clicks++">Ready</button>') }, 150) })()`,
      );
      assert.equal(
        (
          await action({
            action: "click",
            target: { selector: "#late" },
            timeoutMs: 2000,
          })
        ).status,
        "completed",
      );
      assert.equal((await evaluate("window.clicks")).text, "1");
      await evaluate(
        `(() => setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<button class="twins" onclick="window.clicks++">x</button><button class="twins" onclick="window.clicks++">x</button>') }, 150))()`,
      );
      await assert.rejects(
        action({
          action: "click",
          target: { selector: ".twins" },
          timeoutMs: 2000,
        }),
        /matched 2/,
      );
      assert.equal((await evaluate("window.clicks")).text, "1");
      await evaluate(
        `(() => setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<iframe id="child" srcdoc="<section id=scope><button id=inside>Ready</button></section>"></iframe>') }, 150))()`,
      );
      assert.equal(
        (
          await action({
            action: "wait",
            target: {
              selector: "#inside",
              frameSelector: "#child",
              scopeSelector: "#scope",
            },
            timeoutMs: 2000,
          })
        ).status,
        "completed",
      );
      await evaluate(
        `(() => { setTimeout(() => { const frame=document.createElement('iframe'); frame.id='deadline-frame'; frame.onload=()=>setTimeout(()=>frame.contentDocument.body.innerHTML='<button id="too-late">Late</button>', 250); document.body.append(frame) }, 120) })()`,
      );
      const sharedStart = Date.now();
      await assert.rejects(
        action({
          action: "click",
          target: { frameSelector: "#deadline-frame", selector: "#too-late" },
          timeoutMs: 300,
        }),
        /action deadline/,
      );
      assert.ok(Date.now() - sharedStart < 550);
      const before = Date.now();
      await assert.rejects(
        action({
          action: "click",
          target: { selector: "#missing" },
          timeoutMs: 250,
        }),
        /action deadline/,
      );
      assert.ok(Date.now() - before >= 180);
      const abort = new AbortController();
      const pending = action(
        { action: "click", target: { selector: "#never" }, timeoutMs: 5000 },
        abort.signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      abort.abort();
      await assert.rejects(
        pending,
        /already dispatched action may have occurred/,
      );
      await assert.rejects(
        action({ action: "click", target: { selector: "#late" } }),
        /Session unavailable/,
      );
    } finally {
      await sessions.shutdown();
    }
  },
);
