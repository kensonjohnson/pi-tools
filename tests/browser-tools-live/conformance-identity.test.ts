import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";

async function withPage(run: (page: Page) => Promise<void>) {
  const browser = await chromium.launch({
    headless: process.env.BROWSER_HEADED !== "1",
  });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<button id="target">Save</button><input id="value" value="before"><div id="host"></div><script>host.attachShadow({mode:"open"}).innerHTML="<button id=inside>Shadow</button>"</script>',
    );
    await run(page);
  } finally {
    await browser.close();
  }
}

test(
  "document mutation epoch misses live values and shadow mutations",
  { timeout: 30000 },
  async () =>
    withPage(async (page) => {
      await page.evaluate(() => {
        (window as any).epoch = 0;
        new MutationObserver(() => (window as any).epoch++).observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      });
      await page.evaluate(() => {
        (document.querySelector("#value") as HTMLInputElement).value = "after";
        document
          .querySelector("#host")!
          .shadowRoot!.querySelector("#inside")!.textContent = "Changed";
      });
      assert.equal(await page.evaluate(() => (window as any).epoch), 0);
      await page.evaluate(() =>
        document
          .querySelector("#target")!
          .replaceWith(document.querySelector("#target")!.cloneNode(true)),
      );
      assert.ok((await page.evaluate(() => (window as any).epoch)) > 0);
    }),
);

test(
  "epoch detects ordinary DOM replacement during native reference acquisition",
  { timeout: 30000 },
  async () =>
    withPage(async (page) => {
      await page.evaluate(() => {
        (window as any).epoch = 0;
        new MutationObserver(() => (window as any).epoch++).observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      });
      const before = await page.evaluate(() => (window as any).epoch);
      const snapshot = await page.ariaSnapshot({ mode: "ai" });
      const ref = snapshot.match(/button "Save" \[ref=(e\d+)\]/)?.[1];
      assert(ref);
      await page.evaluate(() =>
        document
          .querySelector("#target")!
          .replaceWith(document.querySelector("#target")!.cloneNode(true)),
      );
      const candidate = await page
        .getByRef(ref)
        .elementHandle({ timeout: 500 })
        .catch(() => null);
      const after = await page.evaluate(() => (window as any).epoch);
      assert.notEqual(after, before); // Reject the entire acquisition even if a locator yields a node.
      await candidate?.dispose();
    }),
);

test(
  "retained handle waiting for readiness never clicks a replacement",
  { timeout: 30000 },
  async () =>
    withPage(async (page) => {
      await page.evaluate(() => {
        const b = document.querySelector<HTMLButtonElement>("#target")!;
        b.disabled = true;
        (window as any).clicks = 0;
        document.addEventListener("click", () => (window as any).clicks++);
      });
      const target = await page.locator("#target").elementHandle();
      assert(target);
      const outcome = target.click({ timeout: 1500 }).then(
        () => "clicked",
        () => "failed",
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      await page.evaluate(() => {
        const old = document.querySelector<HTMLButtonElement>("#target")!;
        const replacement = old.cloneNode(true) as HTMLButtonElement;
        replacement.disabled = false;
        old.replaceWith(replacement);
      });
      assert.equal(await outcome, "failed");
      assert.equal(await page.evaluate(() => (window as any).clicks), 0);
      await target.dispose();
    }),
);

test(
  "single-task owned extraction returns data and exact retained nodes",
  { timeout: 30000 },
  async () =>
    withPage(async (page) => {
      // Narrow demonstrator, not an accessible-name implementation. Return a JSHandle, not JSON,
      // so each record's node remains the exact object observed when its label was read.
      const capture = await page.evaluateHandle(() => {
        const roots = [
          document,
          ...Array.from(document.querySelectorAll("*")).flatMap((el) =>
            el.shadowRoot ? [el.shadowRoot] : [],
          ),
        ];
        return roots.flatMap((root) =>
          Array.from(root.querySelectorAll("button")).map((node) => ({
            node,
            label: node.textContent,
            connected: node.isConnected,
          })),
        );
      });
      try {
        const records = await capture.getProperties();
        assert.equal(records.size, 2);
        const record = records.get("0")!;
        const props = await record.getProperties();
        const node = props.get("node")!.asElement();
        assert(node);
        assert.equal(await props.get("label")!.jsonValue(), "Save");
        assert.equal(await props.get("connected")!.jsonValue(), true);
        // Replacement after capture but before handle retrieval cannot change what the record refers to.
        await page.evaluate(() =>
          document
            .querySelector("#target")!
            .replaceWith(document.querySelector("#target")!.cloneNode(true)),
        );
        const again = (await record.getProperties()).get("node")!.asElement();
        assert(again);
        assert.equal(await again.evaluate((el) => el.isConnected), false);
        await assert.rejects(again.click({ timeout: 500 }));
        assert.equal(await page.locator("#target").count(), 1);
        await Promise.all(
          [...props.values()].map((handle) => handle.dispose()),
        );
        await again.dispose();
        await Promise.all(
          [...records.values()].map((handle) => handle.dispose()),
        );
      } finally {
        await capture.dispose();
      }
    }),
);
