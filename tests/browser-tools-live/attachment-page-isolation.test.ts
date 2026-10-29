import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { AttachedPage } from "../../extensions/browser-tools/attachment-page.ts";

async function cdp(url: string) {
  const ws = new WebSocket(url);
  let next = 0;
  const pending = new Map<
    number,
    { resolve(v: any): void; reject(e: Error): void }
  >();
  const events = new Map<string, (value: any) => void>();
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(String(event.data));
    if (data.id) {
      const p = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) p?.reject(new Error(data.error.message));
      else p?.resolve(data.result);
    } else events.get(data.method)?.(data.params);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error("fixture CDP connection failed")),
      { once: true },
    );
  });
  return {
    send(method: string, params: object = {}) {
      const id = ++next;
      return new Promise<any>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    event(name: string) {
      return new Promise<any>((resolve) => events.set(name, resolve));
    },
    close() {
      ws.close();
    },
  };
}
const pendingAfter = async (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(() => false),
    new Promise<true>((r) => setTimeout(() => r(true), 200)),
  ]);

test(
  "page-target connection leaves existing and new unrelated dialogs untouched",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "attachment-page-fixture-"));
    const server = createServer((req, res) => {
      if (req.url === "/chosen") {
        res.setHeader("content-type", "text/html");
        res.end(
          '<title>navigated</title><p>Owned content</p><script>console.log("owned secret"); new Image().src="/chosen-image?token=secret"</script>',
        );
      } else {
        res.setHeader("content-type", "image/png");
        res.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const http = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const child = spawn(
      chromium.executablePath(),
      [
        "--headless",
        "--no-sandbox",
        "--no-first-run",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${join(dir, "profile")}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let browser: Awaited<ReturnType<typeof cdp>> | undefined;
    let unrelated: Awaited<ReturnType<typeof cdp>> | undefined;
    let newTab: Awaited<ReturnType<typeof cdp>> | undefined;
    let selected: AttachedPage | undefined;
    try {
      const ws = await new Promise<string>((resolve, reject) => {
        let text = "";
        child.once("error", reject);
        child.once("exit", () => reject(new Error("fixture exited")));
        child.stderr.on("data", (chunk) => {
          text += chunk.toString();
          const match =
            /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(
              text,
            );
          if (match) resolve(match[1]);
        });
      });
      const endpoint = `http://${new URL(ws).host}`;
      const pageEndpoint = (id: string) =>
        `ws://${new URL(ws).host}/devtools/page/${id}`;
      browser = await cdp(ws);
      const chosenId = (
        await browser.send("Target.createTarget", {
          url: "data:text/html,<title>chosen</title>",
        })
      ).targetId;
      const otherId = (
        await browser.send("Target.createTarget", {
          url: "data:text/html,<title>unrelated</title>",
        })
      ).targetId;
      unrelated = await cdp(pageEndpoint(otherId));
      await unrelated.send("Page.enable");
      const opened = unrelated.event("Page.javascriptDialogOpening");
      const first = unrelated.send("Runtime.evaluate", {
        expression: 'confirm("first unrelated")',
        returnByValue: true,
      });
      await opened;
      assert.equal(await pendingAfter(first), true);
      selected = await AttachedPage.connect(endpoint, chosenId, {
        lockRoot: join(dir, "locks"),
      });
      assert.deepEqual(await selected.title(), {
        title: "chosen",
        truncated: false,
      });
      const metadataProbe = await cdp(pageEndpoint(chosenId));
      await metadataProbe.send("Runtime.evaluate", {
        expression: "document.title = 'a'.repeat(200000) + 'secret'",
      });
      const boundedTitle = await selected.title();
      assert.equal(boundedTitle.title.length, 1024);
      assert.equal(boundedTitle.truncated, true);
      const boundedInspect = await selected.inspect();
      assert.equal(boundedInspect.title.length, 1024);
      assert.equal(boundedInspect.titleTruncated, true);
      await metadataProbe.send("Runtime.evaluate", {
        expression: "document.title = 'A\\u001b\\u202eB'",
      });
      assert.deepEqual(await selected.title(), {
        title: "A \uFFFDB",
        truncated: false,
      });
      await metadataProbe.send("Runtime.evaluate", {
        expression: "document.title = 'chosen'",
      });
      metadataProbe.close();
      await selected.startDiagnostics();
      await assert.rejects(
        AttachedPage.connect(endpoint, chosenId, {
          lockRoot: join(dir, "locks"),
          timeoutMs: 150,
        }),
        /timed out|cancel|unresolved/i,
      );
      await selected.navigate(`${http}/chosen`);
      assert.deepEqual(await selected.title(), {
        title: "navigated",
        truncated: false,
      });
      assert.match((await selected.inspect()).text, /Owned content/);
      assert.equal(await pendingAfter(first), true);
      const thirdId = (
        await browser.send("Target.createTarget", {
          url: "data:text/html,<title>new unrelated</title>",
        })
      ).targetId;
      newTab = await cdp(pageEndpoint(thirdId));
      await browser.send("Target.activateTarget", { targetId: thirdId });
      await newTab.send("Runtime.evaluate", {
        expression: `console.warn('unrelated secret'); new Image().src = '${http}/unrelated-image'`,
      });
      await newTab.send("Page.enable");
      const newOpened = newTab.event("Page.javascriptDialogOpening");
      const second = newTab.send("Runtime.evaluate", {
        expression: 'confirm("second unrelated")',
        returnByValue: true,
      });
      await newOpened;
      assert.equal(await pendingAfter(second), true);
      assert.deepEqual(await selected.title(), {
        title: "navigated",
        truncated: false,
      });
      const evidence = selected.diagnostics().records;
      assert.ok(
        evidence.some(
          (record) => record.kind === "console" && record.level === "log",
        ),
      );
      assert.ok(
        evidence.some(
          (record) =>
            record.kind === "request" && record.url.includes("/chosen-image"),
        ),
      );
      assert.ok(!JSON.stringify(evidence).includes("unrelated"));
      assert.ok(!JSON.stringify(evidence).includes("secret"));
      const chosenProbe = await cdp(pageEndpoint(chosenId));
      await chosenProbe.send("Runtime.evaluate", {
        expression: "for(let i=0;i<150;i++) console.log(i)",
      });
      for (let i = 0; i < 100 && selected.diagnostics().dropped === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(selected.diagnostics().records.length, 100);
      assert.ok(selected.diagnostics().dropped > 0);
      const handle = selected;
      assert.deepEqual(await handle.disconnect(), { uncertain: false });
      assert.throws(() => handle.diagnostics(), /unavailable/);
      selected = undefined;
      assert.equal(
        (
          await chosenProbe.send("Runtime.evaluate", {
            expression: "document.title",
            returnByValue: true,
          })
        ).result.value,
        "navigated",
      );
      chosenProbe.close();
      assert.equal(await pendingAfter(first), true);
      assert.equal(await pendingAfter(second), true);
      await unrelated.send("Page.handleJavaScriptDialog", { accept: true });
      await newTab.send("Page.handleJavaScriptDialog", { accept: true });
      assert.equal((await first).result.value, true);
      assert.equal((await second).result.value, true);
      assert.equal(child.exitCode, null);
    } finally {
      await selected?.disconnect();
      unrelated?.close();
      newTab?.close();
      browser?.close();
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
