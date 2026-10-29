import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { ManagedSessions } from "./sessions.ts";
import { createManagedBrowserExtension } from "./registration.ts";

test(
  "headed picker returns bounded multi-selection metadata without activating controls",
  {
    skip:
      process.env.BROWSER_HEADED !== "1" ||
      !existsSync(chromium.executablePath()),
    timeout: 30000,
  },
  async () => {
    let browser!: Browser;
    const sessions = new ManagedSessions({
      launch: async ({ headless }) => {
        browser = await chromium.launch({ headless });
        return browser;
      },
    });
    const handlers = new Map<string, Function>(),
      tools = new Map<string, any>();
    let active: string[] = [];
    const notices: string[] = [],
      updates: any[] = [];
    const pi = {
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      on: (name: string, fn: Function) => handlers.set(name, fn),
      registerTool: (tool: any) => tools.set(tool.name, tool),
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => {
        active = names;
      },
    };
    const ctx = {
      cwd: "/tmp",
      isProjectTrusted: () => true,
      hasUI: true,
      mode: "tui",
      ui: { notify: (message: string) => notices.push(message) },
      sessionManager: { getSessionId: () => "owner" },
    };
    try {
      createManagedBrowserExtension(pi as never, {
        loadSettings: async () => ({ values: {} }) as never,
        createSessions: () => sessions,
      });
      await handlers.get("session_start")!({}, ctx);
      const target = await sessions.start({
        headless: false,
        artifactOwner: "owner",
      });
      const html = `<section id="group" class="panel"><input id="input" value="private-form-value" style="width:180px;height:80px"><button id="save" style="width:180px;height:80px" data-extra="private-attribute">Save &amp; changes</button></section><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++,true)</script>`;
      await sessions.navigate(
        `data:text/html,${encodeURIComponent(html)}`,
        target,
        undefined,
        30000,
        "owner",
      );
      const page = browser.contexts()[0].pages()[0];
      const boxes = await Promise.all([
        page.locator("#input").boundingBox(),
        page.locator("#save").boundingBox(),
      ]);
      assert.ok(boxes[0] && boxes[1]);
      const pending = tools
        .get("browser_pick")
        .execute(
          "id",
          { ...target, maxSelections: 3 },
          undefined,
          (update: any) => updates.push(update),
          ctx,
        );
      const progress = JSON.parse(updates[0].content[0].text);
      assert.ok(
        notices.some((message) => message.includes("browser-pick-finish")),
      );
      await page.waitForTimeout(700);
      for (const box of boxes) {
        await page.mouse.click(box!.x + 5, box!.y + 5);
        await page.waitForTimeout(250);
      }
      assert.equal(
        (
          await handlers.get("input")!(
            {
              source: "interactive",
              text: `browser-pick-finish ${target.sessionId} ${progress.pickerId}`,
            },
            ctx,
          )
        ).action,
        "handled",
      );
      const result = JSON.parse((await pending).content[0].text);
      assert.equal(result.status, "selected");
      assert.equal(result.actionable, false);
      assert.deepEqual(
        result.selections.map((item: any) => item.id),
        ["input", "save"],
      );
      assert.deepEqual(result.selections[1].parent, {
        tag: "section",
        id: "group",
        classes: ["panel"],
        relation: "parent",
      });
      assert.equal(
        result.selections[1].summary,
        '<button id="save">Save &amp; changes</button>',
      );
      assert.equal(result.selections[1].summaryTruncated, false);
      assert.deepEqual(result.selections[1].summaryOmissions, [
        "other attributes and values",
        "descendant markup",
        "hidden and sensitive content",
      ]);
      assert.match(result.note, /synthetic, not original HTML or a selector/);
      assert.doesNotMatch(
        JSON.stringify(result),
        /private-form-value|private-attribute/,
      );
      assert.equal(await page.evaluate(() => (window as any).clicks), 0);
      assert.equal(
        await page.locator("#input").inputValue(),
        "private-form-value",
      );
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx);
    }
  },
);
