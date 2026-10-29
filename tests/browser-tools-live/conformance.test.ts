import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";

const headed = process.env.BROWSER_HEADED === "1";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(
  run: (
    page: import("playwright").Page,
    url: string,
    submissions: () => number,
  ) => Promise<void>,
) {
  let count = 0;
  const server = createServer((req, res) => {
    if (req.url === "/submit") {
      count++;
      res.writeHead(200);
      res.end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url === "/frame") {
      res.end('<button id="target">Target</button>');
      return;
    }
    res.end(
      `<!doctype html><title>fixture</title><button id="target">Target</button><a id="link" href="/next">Link</a><input aria-label="Visible" value="normal-value"><input aria-label="Password" type="password" value="password-secret"><input type="hidden" value="hidden-secret"><iframe title="Child" src="/frame"></iframe><div id="host"></div><script>window.clicks=0; document.querySelector('#target').onclick=()=>window.clicks++; document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button>';</script>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: !headed });
    const page = await browser.newPage();
    await page.goto(url);
    await run(page, url, () => count);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}

test(
  "snapshot refs and retained handles across resnapshot, replacement and navigation",
  { timeout: 30000 },
  async () =>
    fixture(async (page, url) => {
      const yaml = await page.ariaSnapshot({ mode: "ai" });
      const ref = yaml.match(/button "Target" \[ref=(e\d+)\]/)?.[1];
      assert(ref, yaml);
      const handle = await page.getByRef(ref).elementHandle();
      assert(handle);
      assert.equal(await handle.evaluate((el) => el.id), "target");
      await page.evaluate(() =>
        document.body.append(document.createElement("aside")),
      );
      assert.equal(await handle.evaluate((el) => el.isConnected), true);
      await page.evaluate(() => {
        const old = document.querySelector("#target")!;
        old.replaceWith(old.cloneNode(true));
      });
      assert.equal(await handle.evaluate((el) => el.isConnected), false);
      await assert.rejects(handle.click({ timeout: 500 }));
      const newer = await page.ariaSnapshot({ mode: "ai" });
      const newRef = newer.match(/button "Target" \[ref=(e\d+)\]/)?.[1];
      assert(newRef);
      const replacement = await page.getByRef(newRef).elementHandle();
      assert(replacement);
      assert.equal(await replacement.evaluate((el) => el.isConnected), true);
      // An old string ref must not be trusted after any later snapshot, even if it resolves.
      const oldResult = await page
        .getByRef(ref)
        .elementHandle({ timeout: 500 })
        .catch(() => null);
      if (oldResult)
        assert.equal(await oldResult.evaluate((el) => el.isConnected), true);
      await page.goto(url + "/next");
      await assert.rejects(handle.click({ timeout: 500 }));
      await assert.rejects(replacement.click({ timeout: 500 }));
      await handle.dispose();
      await replacement.dispose();
      await oldResult?.dispose();
    }),
);

test(
  "snapshot coverage, sensitive values and frame lifetime",
  { timeout: 30000 },
  async () =>
    fixture(async (page) => {
      const yaml = await page.ariaSnapshot({ mode: "ai", depth: 8 });
      const json = JSON.stringify(
        await page.ariaSnapshotJSON({ mode: "ai", depth: 8 }),
      );
      const scoped = await page.locator("#host").ariaSnapshot({ mode: "ai" });
      assert.match(yaml, /normal-value/);
      assert.match(yaml, /password-secret/);
      assert.doesNotMatch(yaml, /hidden-secret/);
      assert.match(json, /password-secret/);
      assert.doesNotMatch(json, /hidden-secret/);
      assert.match(yaml, /Shadow action/);
      assert.match(scoped, /Shadow action/);
      assert.match(yaml, /iframe/);
      assert.match(yaml, /f1e\d+/);
      const frame = page.frameLocator("iframe");
      const inner = await frame
        .getByRole("button", { name: "Target" })
        .elementHandle();
      assert(inner);
      await page.locator("iframe").evaluate((el) => el.remove());
      await assert.rejects(inner.click({ timeout: 500 }));
      await inner.dispose();
    }),
);

test(
  "abort before readiness and after dispatch does not imply non-dispatch",
  { timeout: 30000 },
  async () =>
    fixture(async (page, url, submissions) => {
      await page.evaluate(() => {
        const b = document.querySelector<HTMLButtonElement>("#target")!;
        b.disabled = true;
        b.onclick = () => {
          void fetch("/submit");
        };
      });
      const early = new AbortController();
      const pending = page
        .locator("#target")
        .click({ signal: early.signal, timeout: 5000 });
      await delay(100);
      early.abort();
      await assert.rejects(pending);
      await page
        .locator("#target")
        .evaluate((el: HTMLButtonElement) => (el.disabled = false));
      await delay(250);
      assert.equal(submissions(), 0);
      const waitAbort = new AbortController();
      const wait = page.waitForResponse((r) => r.url().endsWith("/never"), {
        signal: waitAbort.signal,
        timeout: 5000,
      });
      await page.locator("#target").click();
      await page.waitForFunction(() => true); // dispatch completed, response wait remains pending
      waitAbort.abort();
      await assert.rejects(wait);
      for (let i = 0; i < 30 && submissions() === 0; i++) await delay(20);
      assert.equal(submissions(), 1);
      const during = new AbortController();
      await page.exposeFunction("abortDuringPointerDown", () => during.abort());
      await page.evaluate(() =>
        document.querySelector("#target")!.addEventListener(
          "pointerdown",
          () => {
            void (window as any).abortDuringPointerDown();
          },
          { once: true },
        ),
      );
      const outcome = await page
        .locator("#target")
        .click({ signal: during.signal, timeout: 5000 })
        .then(
          () => "fulfilled",
          () => "rejected",
        );
      await delay(300);
      console.log(
        `abort on pointerdown: ${outcome}; total submissions=${submissions()}`,
      );
      assert.equal(during.signal.aborted, true);
      assert.ok(submissions() === 1 || submissions() === 2);
    }),
);

test(
  "headed native picker cancellation and nonactivation",
  { skip: !headed, timeout: 30000 },
  async () =>
    fixture(async (page) => {
      const result = page.pickLocator().then(
        (locator) => ({ locator }),
        (error) => ({ error }),
      );
      await delay(500);
      await page.cancelPickLocator();
      const cancelled = await result;
      assert("error" in cancelled);
      const second = page.pickLocator().then(
        (locator) => ({ locator }),
        (error) => ({ error }),
      );
      await delay(500);
      await page.locator("#target").click({ timeout: 3000 });
      const selected = await second;
      assert("locator" in selected);
      assert.equal(await page.evaluate(() => (window as any).clicks), 0);
    }),
);
