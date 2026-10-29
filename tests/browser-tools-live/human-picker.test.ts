import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { pickHumanElement } from "../../extensions/browser-tools/human-picker.ts";

const headed = process.env.BROWSER_HEADED === "1";
const basic = ({ tag, id, classes, text }: any) => ({ tag, id, classes, text });
for (const tag of ["button", "a", "shadow"]) {
  test(
    `picker retains ${tag} without activation`,
    { timeout: 20000, skip: !headed },
    async () => {
      const browser = await chromium.launch({ headless: false });
      try {
        const page = await browser.newPage();
        const element =
          tag === "a"
            ? '<a href="#activated">Pick</a>'
            : "<button>Pick</button>";
        await page.setContent(
          `<div id="host">${tag === "shadow" ? "" : element}</div><script>window.clicks=0;window.addEventListener('click',()=>window.clicks++,true);${tag === "shadow" ? `host.attachShadow({mode:'open'}).innerHTML='${element}'` : ""}</script>`,
        );
        const locator = page.getByText("Pick");
        const box = await locator.boundingBox();
        assert(box);
        let cleanup = 0;
        const pending = pickHumanElement({
          page,
          browser,
          onUncertainFailure: () => {
            cleanup++;
          },
        });
        await page.waitForTimeout(700);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        const result = await pending;
        assert.equal(result.status, "selected");
        if (result.status !== "selected") return;
        assert.equal(await page.evaluate(() => (window as any).clicks), 0);
        assert.equal(cleanup, 0);
        if (tag === "shadow")
          assert.deepEqual(result.selections[0].metadata.parent, {
            tag: "div",
            id: "host",
            classes: [],
            relation: "shadow-host",
          });
        assert.equal(await result.handle.isConnected(), true);
        await locator.evaluate((el) => el.replaceWith(el.cloneNode(true)));
        assert.equal(await result.handle.isConnected(), false);
        await result.handle.dispose();
      } finally {
        await browser.close();
      }
    },
  );
}

test(
  "picker abort, Escape, navigation and dynamic frame change",
  { timeout: 30000, skip: !headed },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.setContent("<button>Pick</button>");
      let failures = 0;
      const cleanup = () => {
        failures++;
      };
      const controller = new AbortController();
      const abort = pickHumanElement({
        page,
        browser,
        signal: controller.signal,
        onUncertainFailure: cleanup,
      });
      await page.waitForTimeout(700);
      controller.abort();
      assert.equal((await abort).status, "cancelled");
      const escape = pickHumanElement({
        page,
        browser,
        onUncertainFailure: cleanup,
      });
      await page.waitForTimeout(700);
      await page.keyboard.press("Escape");
      assert.equal((await escape).status, "cancelled");
      const navigation = pickHumanElement({
        page,
        browser,
        onUncertainFailure: cleanup,
      });
      await page.waitForTimeout(700);
      await page.goto("data:text/html,next");
      assert.equal((await navigation).status, "cancelled");
      const frameChange = pickHumanElement({
        page,
        browser,
        onUncertainFailure: cleanup,
      });
      await page.waitForTimeout(700);
      await page.evaluate(() => {
        document.body.appendChild(document.createElement("iframe"));
      });
      assert.equal((await frameChange).status, "cancelled");
      assert.equal(failures, 0);
    } finally {
      await browser.close();
    }
  },
);

for (const crossOrigin of [false, true]) {
  for (const kind of ["button", "link", "shadow"]) {
    test(
      `picker selects ${kind} in ${crossOrigin ? "OOPIF" : "same-process frame"}`,
      { timeout: 20000, skip: !headed },
      async () => {
        const server = createServer((req, res) => {
          res.setHeader("Content-Type", "text/html");
          const port = (server.address() as any).port;
          if (req.url === "/child") {
            const element =
              kind === "link"
                ? '<a href="#activated">Pick</a>'
                : "<button>Pick</button>";
            res.end(
              `<div id="host">${kind === "shadow" ? "" : element}</div><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++,true);${kind === "shadow" ? `host.attachShadow({mode:'open'}).innerHTML='${element}'` : ""}</script>`,
            );
          } else {
            res.end(
              `<iframe style="width:300px;height:150px" src="http://${crossOrigin ? "localhost" : "127.0.0.1"}:${port}/child"></iframe>`,
            );
          }
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const port = (server.address() as any).port;
        const browser = await chromium.launch({
          headless: false,
          args: ["--site-per-process"],
        });
        try {
          const page = await browser.newPage();
          await page.goto(`http://127.0.0.1:${port}/`);
          const locator = page.frameLocator("iframe").getByText("Pick");
          await locator.waitFor();
          const frame = page.frames().find((f) => f.url().includes("/child"));
          assert(frame);
          const check = await page.context().newCDPSession(page);
          const targets = await check.send("Target.getTargets");
          assert.equal(
            targets.targetInfos.some(
              (target) =>
                target.type === "iframe" && target.url.includes("/child"),
            ),
            crossOrigin,
          );
          await check.detach();
          const box = await locator.boundingBox();
          assert(box);
          let failures = 0;
          const pending = pickHumanElement({
            page,
            browser,
            onUncertainFailure: () => {
              failures++;
            },
          });
          await page.waitForTimeout(1000);
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          const result = await pending;
          assert.equal(result.status, "selected");
          if (result.status !== "selected") return;
          assert.equal(await frame.evaluate(() => (window as any).clicks), 0);
          assert.equal(failures, 0);
          assert.equal(await result.handle.isConnected(), true);
          await locator.evaluate((el) => el.replaceWith(el.cloneNode(true)));
          assert.equal(await result.handle.isConnected(), false);
          await result.handle.dispose();
        } finally {
          await browser.close();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );
  }
}

test(
  "child frame navigation invalidates a pending picker",
  { timeout: 20000, skip: !headed },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.setContent('<iframe srcdoc="<button>Pick</button>"></iframe>');
      const frame = page.frames()[1];
      await frame.getByRole("button").waitFor();
      let failures = 0;
      const pending = pickHumanElement({
        page,
        browser,
        onUncertainFailure: () => {
          failures++;
        },
      });
      await page.waitForTimeout(700);
      await frame.goto("data:text/html,<button>Next</button>");
      assert.equal((await pending).status, "cancelled");
      assert.equal(failures, 0);
    } finally {
      await browser.close();
    }
  },
);

for (const crossOrigin of [false, true]) {
  test(
    `removing ${crossOrigin ? "OOPIF" : "same-process frame"} cancels without quarantine`,
    { timeout: 20000, skip: !headed },
    async () => {
      const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html");
        const port = (server.address() as any).port;
        res.end(
          req.url === "/child"
            ? "<button>Child</button>"
            : `<button id="root">Root</button><iframe src="http://${crossOrigin ? "localhost" : "127.0.0.1"}:${port}/child"></iframe><script>window.clicks=0;root.onclick=()=>window.clicks++</script>`,
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const browser = await chromium.launch({
        headless: false,
        args: ["--site-per-process"],
      });
      try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
        await page.frameLocator("iframe").getByRole("button").waitFor();
        const check = await page.context().newCDPSession(page);
        const targets = await check.send("Target.getTargets");
        assert.equal(
          targets.targetInfos.some(
            (target) =>
              target.type === "iframe" && target.url.includes("/child"),
          ),
          crossOrigin,
        );
        await check.detach();
        let failures = 0;
        const pending = pickHumanElement({
          page,
          browser,
          onUncertainFailure: () => {
            failures++;
          },
        });
        await page.waitForTimeout(800);
        await page.locator("iframe").evaluate((el) => el.remove());
        const result = await pending;
        assert.deepEqual(result, {
          status: "cancelled",
          reason: "frame change",
        });
        assert.equal(failures, 0);
        await page.locator("#root").click();
        assert.equal(await page.evaluate(() => (window as any).clicks), 1);
      } finally {
        await browser.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
}

test(
  "multiple selections finish explicitly, retain identities and expose bounded metadata",
  { timeout: 20000, skip: !headed },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.setContent(`<button id="save" class="primary action" style="width:180px;height:80px"><span>Save changes</span></button>
      <a id="next" href="#activated" style="display:inline-block;width:180px;height:80px">Next page</a>
      <script>window.clicks=0;document.addEventListener('click',()=>window.clicks++,true)</script>`);
      const done = new AbortController();
      const pending = pickHumanElement({
        page,
        browser,
        maxSelections: 3,
        finishSignal: done.signal,
        onUncertainFailure: () => assert.fail("unexpected cleanup"),
      });
      await page.waitForTimeout(700);
      for (const selector of ["#save", "#next"]) {
        const box = await page.locator(selector).boundingBox();
        assert(box);
        await page.mouse.click(box.x + 5, box.y + 5);
        await page.waitForTimeout(250);
      }
      done.abort();
      const result = await pending;
      assert.equal(result.status, "selected");
      if (result.status !== "selected") return;
      assert.equal(result.selections.length, 2);
      assert.deepEqual(basic(result.selections[0].metadata), {
        tag: "button",
        id: "save",
        classes: ["primary", "action"],
        text: "Save changes",
      });
      assert.deepEqual(basic(result.selections[1].metadata), {
        tag: "a",
        id: "next",
        classes: [],
        text: "Next page",
      });
      assert.equal(await page.evaluate(() => (window as any).clicks), 0);
      await result.selections[0].handle.dispose();
      assert.equal(await result.selections[1].handle.isConnected(), true);
      await page
        .locator("#next")
        .evaluate((el) => el.replaceWith(el.cloneNode(true)));
      assert.equal(await result.selections[1].handle.isConnected(), false);
      await result.selections[1].handle.dispose();
    } finally {
      await browser.close();
    }
  },
);

test(
  "multi-selection retains handles across root and OOPIF targets",
  { timeout: 20000, skip: !headed },
  async () => {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      const port = (server.address() as any).port;
      res.end(
        req.url === "/child"
          ? '<button id="child">Child</button><script>window.clicks=0;document.addEventListener("click",()=>window.clicks++)</script>'
          : `<button id="root">Root</button><iframe src="http://localhost:${port}/child"></iframe><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++)</script>`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const browser = await chromium.launch({
      headless: false,
      args: ["--site-per-process"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
      const child = page.frameLocator("iframe").locator("button");
      await child.waitFor();
      const pending = pickHumanElement({
        page,
        browser,
        maxSelections: 2,
        onUncertainFailure: () => {},
      });
      await page.waitForTimeout(700);
      for (const locator of [page.locator("#root"), child]) {
        const box = await locator.boundingBox();
        assert(box);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(250);
      }
      const result = await pending;
      assert.equal(result.status, "selected");
      if (result.status !== "selected") return;
      assert.deepEqual(
        result.selections.map((s) => s.metadata.id),
        ["root", "child"],
      );
      assert.equal(await page.evaluate(() => (window as any).clicks), 0);
      assert.equal(await child.evaluate(() => (window as any).clicks), 0);
      await result.selections[0].handle.dispose();
      assert.equal(await result.selections[1].handle.isConnected(), true);
      await result.selections[1].handle.dispose();
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "a replaced partial selection cancels instead of returning a stale node",
  { timeout: 20000, skip: !headed },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<button style="width:180px;height:80px">Pick</button>',
      );
      const done = new AbortController();
      const pending = pickHumanElement({
        page,
        browser,
        maxSelections: 2,
        finishSignal: done.signal,
        onUncertainFailure: () => {},
      });
      await page.waitForTimeout(700);
      const box = await page.locator("button").boundingBox();
      assert(box);
      await page.mouse.click(box.x + 5, box.y + 5);
      await page.waitForTimeout(250);
      await page
        .locator("button")
        .evaluate((el) => el.replaceWith(el.cloneNode(true)));
      done.abort();
      assert.equal((await pending).status, "cancelled");
    } finally {
      await browser.close();
    }
  },
);

test(
  "selection limit completes automatically with bounded metadata",
  { timeout: 20000, skip: !headed },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<button id="${"i:".repeat(50)}" class="${Array.from({ length: 15 }, (_, i) => `c${i}`).join(" ")}" style="width:200px;height:80px">${"x".repeat(500)}</button>`,
      );
      const pending = pickHumanElement({
        page,
        browser,
        maxSelections: 1,
        onUncertainFailure: () => {},
      });
      await page.waitForTimeout(700);
      const box = await page.locator("button").boundingBox();
      assert(box);
      await page.mouse.click(box.x + 5, box.y + 5);
      const result = await pending;
      assert.equal(result.status, "selected");
      if (result.status !== "selected") return;
      const metadata = result.selections[0].metadata;
      assert.equal(metadata.id.length, 80);
      assert.equal(metadata.classes.length, 8);
      assert.equal(metadata.summaryTruncated, true);
      assert.ok(metadata.text.length <= 160);
      await result.handle.dispose();
    } finally {
      await browser.close();
    }
  },
);

test(
  "picker returns a synthetic escaped summary and non-actionable parent context",
  { timeout: 20000, skip: !headed },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<section id="group" class="panel"><button id="save" class="main" data-private-value="dontshow" title="otherprivate" style="width:240px;height:90px">Hello &amp; &lt;world&gt;<span hidden>hiddenword</span><input type="hidden" value="concealedvalue"></button></section>`,
      );
      const pending = pickHumanElement({
        page,
        browser,
        onUncertainFailure: () => {},
      });
      await page.waitForTimeout(700);
      const box = await page.locator("#save").boundingBox();
      assert(box);
      await page.mouse.click(box.x + 5, box.y + 5);
      const result = await pending;
      assert.equal(result.status, "selected");
      if (result.status !== "selected") return;
      const metadata = result.selections[0].metadata;
      assert.deepEqual(metadata.parent, {
        tag: "section",
        id: "group",
        classes: ["panel"],
        relation: "parent",
      });
      assert.equal(
        metadata.summary,
        '<button id="save" class="main">Hello &amp; &lt;world&gt;</button>',
      );
      assert.equal(metadata.summaryTruncated, false);
      assert.deepEqual(metadata.summaryOmissions, [
        "other attributes and values",
        "descendant markup",
        "hidden and sensitive content",
      ]);
      assert.doesNotMatch(
        JSON.stringify(metadata),
        /hiddenword|concealedvalue|dontshow|otherprivate/,
      );
      await result.handle.dispose();
    } finally {
      await browser.close();
    }
  },
);

test(
  "picker metadata excludes hidden and non-visible descendant text",
  { timeout: 20000, skip: !headed },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.setContent(`<button id="pick" style="width:250px;height:100px">Visible label
      <span hidden>hiddenword</span><span style="display:none">displayword</span>
      <span aria-hidden="true">ariaword</span><span style="visibility:hidden">visibilityword</span>
      <span style="content-visibility:hidden">contentword</span><span style="opacity:0">opacityword</span>
      <input value="inputword"><textarea>textareaword</textarea>
      <script>window.fixtureOnly='scriptword'</script><style>.fixtureOnly { content:'styleword' }</style>
    </button>`);
      const pending = pickHumanElement({
        page,
        browser,
        onUncertainFailure: () => {},
      });
      await page.waitForTimeout(700);
      const box = await page.locator("#pick").boundingBox();
      assert(box);
      await page.mouse.click(box.x + 5, box.y + 5);
      const result = await pending;
      assert.equal(result.status, "selected");
      if (result.status !== "selected") return;
      assert.equal(result.selections[0].metadata.text, "Visible label");
      await result.handle.dispose();
    } finally {
      await browser.close();
    }
  },
);

test(
  "metadata omits form values and bounded sensitive text",
  { timeout: 20000, skip: !headed },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<input id="login" type="password" value="swordfish-private-value" style="width:200px;height:80px">`,
      );
      const pending = pickHumanElement({
        page,
        browser,
        onUncertainFailure: () => {},
      });
      await page.waitForTimeout(700);
      const box = await page.locator("input").boundingBox();
      assert(box);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const result = await pending;
      assert.equal(result.status, "selected");
      if (result.status !== "selected") return;
      assert.deepEqual(basic(result.selections[0].metadata), {
        tag: "input",
        id: "login",
        classes: [],
        text: "",
      });
      assert.doesNotMatch(
        JSON.stringify(result.selections[0].metadata),
        /swordfish/,
      );
      await result.handle.dispose();
    } finally {
      await browser.close();
    }
  },
);

for (const cancel of ["abort", "escape", "navigation"]) {
  test(
    `multiple picker discards partial selections on ${cancel}`,
    { timeout: 20000, skip: !headed },
    async () => {
      const browser = await chromium.launch({ headless: false });
      try {
        const page = await browser.newPage();
        await page.setContent(
          '<button style="width:180px;height:80px">Pick</button><script>window.clicks=0;document.addEventListener("click",()=>window.clicks++)</script>',
        );
        const controller = new AbortController();
        const pending = pickHumanElement({
          page,
          browser,
          maxSelections: 3,
          signal: controller.signal,
          onUncertainFailure: () => {},
        });
        await page.waitForTimeout(700);
        const box = await page.locator("button").boundingBox();
        assert(box);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(250);
        if (cancel === "abort") controller.abort();
        else if (cancel === "escape") await page.keyboard.press("Escape");
        else await page.goto("data:text/html,next");
        assert.equal((await pending).status, "cancelled");
        if (cancel !== "navigation") {
          assert.equal(await page.evaluate(() => (window as any).clicks), 0);
          await page.locator("button").click();
          assert.equal(await page.evaluate(() => (window as any).clicks), 1);
        }
      } finally {
        await browser.close();
      }
    },
  );
}

test(
  "browser disconnect triggers owned cleanup",
  { timeout: 20000, skip: !headed },
  async () => {
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    await page.setContent("<button>Pick</button>");
    let failures = 0;
    const pending = pickHumanElement({
      page,
      browser,
      onUncertainFailure: () => {
        failures++;
      },
    });
    await page.waitForTimeout(700);
    await browser.close();
    assert.equal((await pending).status, "cancelled");
    assert.equal(failures, 1);
  },
);
