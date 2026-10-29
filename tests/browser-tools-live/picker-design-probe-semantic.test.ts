import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium, type Frame } from "playwright";

// A bounded demonstrator, not an accessibility tree or accessible-name implementation.
async function capture(frame: Frame, maxVisited = 100) {
  return frame.evaluateHandle((limit) => {
    const records: Array<{
      node: Element;
      role: string;
      label: string;
      value?: string;
    }> = [];
    const omissions = {
      truncated: false,
      closedShadowUnknown: true,
      frameContentsSeparate: false,
    };
    let visited = 0;
    const visit = (root: Document | ShadowRoot | Element) => {
      for (const child of Array.from(root.children)) {
        if (visited >= limit) {
          omissions.truncated = true;
          return;
        }
        visited++;
        const el = child as HTMLElement;
        const style = getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          el.hidden ||
          el.getAttribute("aria-hidden") === "true"
        )
          continue;
        if (el.tagName === "IFRAME") {
          omissions.frameContentsSeparate = true;
          continue;
        }
        const input = el instanceof HTMLInputElement ? el : null;
        if (input?.type === "hidden") continue;
        const role =
          el.getAttribute("role") ||
          (el.tagName === "BUTTON"
            ? "button"
            : el.tagName === "A" && el.hasAttribute("href")
              ? "link"
              : input
                ? input.type === "password" || input.type === "text"
                  ? "textbox"
                  : input.type
                : "");
        const rect = el.getBoundingClientRect();
        if (role && rect.width > 0 && rect.height > 0) {
          const label = (
            el.getAttribute("aria-label") ||
            input?.labels?.[0]?.textContent ||
            el.textContent ||
            ""
          )
            .trim()
            .slice(0, 120);
          const record: {
            node: Element;
            role: string;
            label: string;
            value?: string;
          } = { node: el, role, label };
          if (input && input.type !== "password")
            record.value = input.value.slice(0, 120);
          records.push(record);
        }
        if (el.shadowRoot) visit(el.shadowRoot);
        visit(el);
      }
    };
    visit(document);
    return { records, omissions, visited };
  }, maxVisited);
}

async function unpack(handle: Awaited<ReturnType<typeof capture>>) {
  const props = await handle.getProperties();
  const list = props.get("records")!;
  const entries = await list.getProperties();
  const result = [];
  for (const entry of entries.values()) {
    const p = await entry.getProperties();
    const node = p.get("node")!.asElement();
    assert(node);
    const role = await p.get("role")!.jsonValue();
    const label = await p.get("label")!.jsonValue();
    const value = p.get("value")
      ? await p.get("value")!.jsonValue()
      : undefined;
    result.push({ node, role, label, value });
    for (const [key, h] of p) if (key !== "node") await h.dispose();
    await entry.dispose();
  }
  const omissions = await props.get("omissions")!.jsonValue();
  await Promise.all([...props.values()].map((h) => h.dispose()));
  return { result, omissions };
}

test(
  "synchronous capture binds observed semantics to exact nodes across subsequent mutations",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<label for="user">User</label><input id="user" value="Ada"><input type="password" aria-label="Password" value="secret"><input type="hidden" value="hidden-secret"><button id="save" aria-label="Save">ignored</button><button style="display:none">Invisible</button><div id="host"></div><div role="button" aria-label="Custom" tabindex="0" style="width:30px;height:30px"></div><script>host.attachShadow({mode:'open'}).innerHTML='<button>Shadow</button>'</script>`,
      );
      const captured = await capture(page.mainFrame());
      // Mutate after the one synchronous task but before any handle properties are obtained.
      await page.evaluate(() => {
        const old = document.querySelector("#save")!;
        old.setAttribute("aria-label", "Changed");
        old.replaceWith(old.cloneNode(true));
        (document.querySelector("#user") as HTMLInputElement).value = "Bob";
      });
      const { result, omissions } = await unpack(captured);
      assert.deepEqual(
        result.map((x) => x.label),
        ["User", "Password", "Save", "Shadow", "Custom"],
      );
      assert.equal(result.find((x) => x.label === "User")?.value, "Ada");
      assert.equal(
        result.find((x) => x.label === "Password")?.value,
        undefined,
      );
      assert(
        !JSON.stringify(
          result.map(({ role, label, value }) => ({ role, label, value })),
        ).includes("secret"),
      );
      assert.equal((omissions as any).closedShadowUnknown, true);
      const save = result.find((x) => x.label === "Save")!;
      assert.equal(await save.node.evaluate((el) => el.isConnected), false);
      await assert.rejects(save.node.click({ timeout: 500 }));
      assert.equal(
        await page.locator("#save").getAttribute("aria-label"),
        "Changed",
      );
      const bounded = await capture(page.mainFrame(), 2);
      const limited = await unpack(bounded);
      assert.equal((limited.omissions as any).truncated, true);
      await Promise.all(
        [...result, ...limited.result].map((r) => r.node.dispose()),
      );
      await captured.dispose();
      await bounded.dispose();
    } finally {
      await browser.close();
    }
  },
);

test(
  "separate OOPIF extraction remains scoped to its document and invalidates on navigation",
  { timeout: 30000 },
  async () => {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        req.url === "/child"
          ? "<button>Child</button>"
          : `<button>Main</button><iframe src="http://localhost:${(server.address() as any).port}/child"></iframe>`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
      args: ["--site-per-process"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
      await page.frameLocator("iframe").getByRole("button").waitFor();
      const cdp = await page.context().newCDPSession(page);
      assert(
        (await cdp.send("Target.getTargets")).targetInfos.some(
          (t) => t.type === "iframe" && t.url.includes("/child"),
        ),
      );
      const child = page.frames().find((f) => f.url().includes("/child"));
      assert(child);
      const mainCapture = await capture(page.mainFrame());
      const childCapture = await capture(child);
      const main = await unpack(mainCapture);
      const inner = await unpack(childCapture);
      assert.deepEqual(
        main.result.map((r) => r.label),
        ["Main"],
      );
      assert.equal((main.omissions as any).frameContentsSeparate, true);
      assert.deepEqual(
        inner.result.map((r) => r.label),
        ["Child"],
      );
      await page
        .locator("iframe")
        .evaluate((el) => ((el as HTMLIFrameElement).src = "about:blank"));
      await child.waitForURL("about:blank");
      await assert.rejects(inner.result[0].node.click({ timeout: 500 }));
      assert.equal(
        await main.result[0].node.evaluate((el) => el.isConnected),
        true,
      );
      await Promise.all(
        [...main.result, ...inner.result].map((r) =>
          r.node.dispose().catch(() => {}),
        ),
      );
      await mainCapture.dispose();
      await childCapture.dispose().catch(() => {});
      await cdp.detach();
    } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
