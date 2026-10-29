import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { SemanticSnapshots } from "../../extensions/browser-tools/semantic-snapshots.ts";

test(
  "many frame omissions and long metadata fit the complete output budget",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<title>${"🦊".repeat(600)}</title><section id="target"><button>Go</button></section>${'<iframe style="display:none" srcdoc="<button>hidden</button>"></iframe>'.repeat(35)}`,
      );
      const snapshots = new SemanticSnapshots(page);
      const result = await snapshots.snapshot({ maxChars: 512 });
      assert(Buffer.byteLength(JSON.stringify(result)) <= 512);
      assert(result.omitted.some((s) => /omission notices suppressed/.test(s)));
      assert(result.omitted.some((s) => /Closed shadow/.test(s)));
      assert(!JSON.stringify(result).includes('"name":"hidden"'));
      const scoped = await snapshots.snapshot({
        selector: "#target",
        maxChars: 512,
      });
      assert(Buffer.byteLength(JSON.stringify(scoped)) <= 512);
      assert(
        scoped.omitted.some((s) => /duplicate IDs are not checked/.test(s)),
      );
      await snapshots.dispose();
    } finally {
      await browser.close();
    }
  },
);
