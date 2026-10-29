import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium, type CDPSession } from "playwright";

// Deliberately narrow isolated-world fixture extractor, not an accessibility algorithm.
function collect() {
  const records: Array<{
    node: Element;
    role: string;
    label: string;
    value?: string;
  }> = [];
  let count = 0,
    truncated = false,
    frameBoundary = false;
  const walk = (parent: Document | ShadowRoot | Element) => {
    for (const el of Array.from(parent.children)) {
      if (++count > 100) {
        truncated = true;
        return;
      }
      const s = getComputedStyle(el);
      if (
        s.display === "none" ||
        s.visibility === "hidden" ||
        el.hasAttribute("hidden") ||
        el.getAttribute("aria-hidden") === "true"
      )
        continue;
      if (el.tagName === "IFRAME") {
        frameBoundary = true;
        continue;
      }
      const input = el instanceof HTMLInputElement ? el : null;
      if (input?.type === "hidden") continue;
      const role = el.tagName === "BUTTON" ? "button" : input ? "textbox" : "";
      if (role) {
        const label = (
          el.getAttribute("aria-label") ||
          input?.labels?.[0]?.textContent ||
          el.textContent ||
          ""
        )
          .trim()
          .slice(0, 100);
        const record: {
          node: Element;
          role: string;
          label: string;
          value?: string;
        } = { node: el, role, label };
        if (input && input.type !== "password")
          record.value = input.value.slice(0, 100);
        records.push(record);
      }
      if (el.shadowRoot) walk(el.shadowRoot);
      walk(el);
    }
  };
  walk(document);
  return { records, truncated, frameBoundary, closedShadowUnknown: true };
}
async function capture(cdp: CDPSession, afterSnapshot?: () => Promise<void>) {
  const tree = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: tree.frameTree.frame.id,
    worldName: "semantic-probe",
  });
  const evaluated = await cdp.send("Runtime.evaluate", {
    contextId: executionContextId,
    expression: `(${collect.toString()})()`,
    objectGroup: "semantic-probe",
    returnByValue: false,
  });
  assert(!evaluated.exceptionDetails, evaluated.exceptionDetails?.text);
  assert(evaluated.result.objectId);
  const root = evaluated.result.objectId;
  const summary = await cdp.send("Runtime.callFunctionOn", {
    objectId: root,
    functionDeclaration: `function(){return {records:this.records.map(({role,label,value})=>({role,label,value})),truncated:this.truncated,frameBoundary:this.frameBoundary,closedShadowUnknown:this.closedShadowUnknown}}`,
    returnByValue: true,
    objectGroup: "semantic-probe",
  });
  await afterSnapshot?.();
  const rootProps = await cdp.send("Runtime.getProperties", {
    objectId: root,
    ownProperties: true,
  });
  const recordsId = rootProps.result.find((p) => p.name === "records")?.value
    ?.objectId;
  assert(recordsId);
  const entries = await cdp.send("Runtime.getProperties", {
    objectId: recordsId,
    ownProperties: true,
  });
  const ids: string[] = [];
  for (const entry of entries.result.filter((e) => /^\d+$/.test(e.name))) {
    assert(entry.value?.objectId);
    const props = await cdp.send("Runtime.getProperties", {
      objectId: entry.value.objectId,
      ownProperties: true,
    });
    const id = props.result.find((p) => p.name === "node")?.value?.objectId;
    assert(id);
    ids.push(id);
  }
  return { summary: summary.result.value, ids, contextId: executionContextId };
}
async function connected(cdp: CDPSession, objectId: string) {
  const r = await cdp
    .send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(){return this.isConnected}",
      returnByValue: true,
    })
    .catch(() => null);
  return r?.result.value ?? false;
}

test(
  "isolated CDP record retains exact original node and redacted fixture metadata",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<label for="u">User</label><input id="u" value="Ada"><input type="password" aria-label="Password" value="secret"><input type="hidden" value="hidden-secret"><button id="save" aria-label="Save">x</button><div id="host"></div><script>host.attachShadow({mode:'open'}).innerHTML='<button>Shadow</button>';Element.prototype.getAttribute=function(){return 'spoofed'};</script>`,
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.enable");
      const captured = await capture(cdp, async () => {
        await page.evaluate(() => {
          const old = document.querySelector("#save")!;
          old.setAttribute("aria-label", "Changed");
          old.replaceWith(old.cloneNode(true));
          (document.querySelector("#u") as HTMLInputElement).value = "Bob";
        });
      });
      assert.deepEqual(
        captured.summary.records.map((r: any) => r.label),
        ["User", "Password", "Save", "Shadow"],
      );
      assert.equal(captured.summary.records[0].value, "Ada");
      assert(!JSON.stringify(captured.summary).includes("secret"));
      assert.equal(await connected(cdp, captured.ids[2]), false);
      assert.equal(await connected(cdp, captured.ids[0]), true);
      assert.equal(captured.summary.records[0].value, "Ada");
      await page.goto("data:text/html,<button>Save</button>");
      assert.equal(await connected(cdp, captured.ids[0]), false);
      await page.setContent(
        "<div>" + "<button>B</button>".repeat(120) + "</div>",
      );
      const bounded = await capture(cdp);
      assert.equal(bounded.summary.truncated, true);
      assert(bounded.summary.records.length < 120);
      await cdp.send("Runtime.releaseObjectGroup", {
        objectGroup: "semantic-probe",
      });
      await cdp.detach();
    } finally {
      await browser.close();
    }
  },
);

test(
  "isolated capture uses separate sessions and documents for OOPIF provenance",
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
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
      args: ["--site-per-process"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
      await page.frameLocator("iframe").getByRole("button").waitFor();
      const mainCdp = await page.context().newCDPSession(page);
      assert(
        (await mainCdp.send("Target.getTargets")).targetInfos.some(
          (t) => t.type === "iframe" && t.url.includes("/child"),
        ),
      );
      const frame = page.frames().find((f) => f.url().includes("/child"));
      assert(frame);
      const childCdp = await page.context().newCDPSession(frame);
      const main = await capture(mainCdp),
        child = await capture(childCdp);
      assert.deepEqual(
        main.summary.records.map((r: any) => r.label),
        ["Main"],
      );
      assert.equal(main.summary.frameBoundary, true);
      assert.deepEqual(
        child.summary.records.map((r: any) => r.label),
        ["Child"],
      );
      assert.equal(await connected(mainCdp, child.ids[0]), false);
      await page
        .locator("iframe")
        .evaluate((el) => ((el as HTMLIFrameElement).src = "about:blank"));
      await frame.waitForURL("about:blank");
      assert.equal(await connected(childCdp, child.ids[0]), false);
      assert.equal(await connected(mainCdp, main.ids[0]), true);
      await childCdp.detach().catch(() => {});
      await mainCdp.send("Runtime.releaseObjectGroup", {
        objectGroup: "semantic-probe",
      });
      await mainCdp.detach();
    } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
