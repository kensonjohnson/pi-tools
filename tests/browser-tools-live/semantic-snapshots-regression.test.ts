import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { SemanticSnapshots } from "../../extensions/browser-tools/semantic-snapshots.ts";

test(
  "content visibility, shadow label and frame reference visibility",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<div style="content-visibility:hidden"><p>do-not-disclose</p><button>Hidden button</button></div><button id="outer">Outer <span style="content-visibility:hidden">secret-name</span></button><div style="content-visibility:hidden"><span id="hidden-label">secret-reference</span></div><button aria-labelledby="hidden-label">Fallback</button><div id="shadow"></div><iframe srcdoc="<button>Child</button>"></iframe><script>shadow.attachShadow({mode:'open'}).innerHTML='<span id="lab">Shadow label</span><button aria-labelledby="lab"></button>'</script>`,
      );
      const snapshots = new SemanticSnapshots(page);
      const result = await snapshots.snapshot();
      assert(!JSON.stringify(result).includes("do-not-disclose"));
      assert(!JSON.stringify(result).includes("secret-name"));
      assert(!JSON.stringify(result).includes("secret-reference"));
      const shadowRef = result.records.find(
        (r) => r.role === "button" && r.name === "Shadow label",
      )?.ref;
      assert(shadowRef);
      assert(await snapshots.resolve(shadowRef));
      const child = result.records.find((r) => r.name === "Child")?.ref;
      assert(child);
      await page
        .locator("iframe")
        .evaluate((el) => ((el as HTMLElement).style.display = "none"));
      await assert.rejects(snapshots.resolve(child), /Stale/);
      const outer = result.records.find((r) => r.name === "Outer")?.ref;
      assert(outer);
      await page
        .locator("#outer")
        .evaluate(
          (el) => ((el as HTMLElement).style.contentVisibility = "hidden"),
        );
      await assert.rejects(snapshots.resolve(outer), /Stale/);
      await snapshots.dispose();
    } finally {
      await browser.close();
    }
  },
);

test(
  "oversized metadata skips only the affected subtree and preserves safe references",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const snapshots = new SemanticSnapshots(page);
      await page.setContent(
        `<button>Before</button><a href="${"x".repeat(300000)}">Link</a><button aria-labelledby="${"a ".repeat(20)}">Bad labels</button><button aria-labelledby="${"a".repeat(100000)}">Huge labels</button><button>After</button>`,
      );
      const result = await snapshots.snapshot();
      assert(result.omitted.some((x) => /3 subtrees omitted/.test(x)));
      assert(
        !result.records.some((r) =>
          ["Link", "Bad labels", "Huge labels"].includes(r.name),
        ),
      );
      const before = result.records.find((r) => r.name === "Before")?.ref;
      const after = result.records.find((r) => r.name === "After")?.ref;
      assert(before && after);
      assert(await snapshots.resolve(before));
      assert(await snapshots.resolve(after));
      await assert.rejects(
        snapshots.snapshot({ selector: "x".repeat(1025) }),
        /selector exceeds limit/,
      );
      await snapshots.dispose();
    } finally {
      await browser.close();
    }
  },
);
