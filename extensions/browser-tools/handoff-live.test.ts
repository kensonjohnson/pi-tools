import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { ManagedSessions } from "./sessions.ts";
import { createManagedBrowserExtension } from "./registration.ts";

test(
  "visible login handoff stays paused through page changes until user input",
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
    const handlers = new Map<string, Function>();
    const tools = new Map<string, any>();
    let active: string[] = [];
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
      ui: { notify() {} },
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
      const html = `<input id="code"><button onclick="document.body.dataset.done='yes'">Sign in</button>`;
      await sessions.navigate(
        `data:text/html,${encodeURIComponent(html)}`,
        target,
        undefined,
        30000,
        "owner",
      );
      const handoff = JSON.parse(
        (
          await tools
            .get("browser_handoff")
            .execute(
              "id",
              { ...target, action: "pause" },
              undefined,
              undefined,
              ctx,
            )
        ).content[0].text,
      );
      const page = browser.contexts()[0].pages()[0];
      await page.locator("#code").fill("123456");
      await page.getByRole("button", { name: "Sign in" }).click();
      assert.equal(
        sessions.handoffStatus(target.sessionId, "owner").status,
        "awaiting_human",
      );
      await assert.rejects(
        sessions.content(target, undefined, "owner"),
        /awaiting human/,
      );
      await handlers.get("input")!(
        {
          source: "interactive",
          text: `browser-resume ${target.sessionId} ${handoff.handoffId}`,
        },
        ctx,
      );
      const content = await sessions.content(target, undefined, "owner");
      assert.match(content.html, /data-done="yes"/);
    } finally {
      await handlers.get("session_shutdown")?.();
    }
  },
);
