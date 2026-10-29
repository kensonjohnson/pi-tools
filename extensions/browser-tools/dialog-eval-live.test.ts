import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { ManagedSessions } from "./sessions.ts";
import { createManagedBrowserExtension } from "./registration.ts";
import { ArtifactStore } from "./artifacts.ts";

test(
  "aborting after an eval dialog handoff closes the owned session without accepting",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const sessions = new ManagedSessions({
      launch: ({ headless }) => chromium.launch({ headless }),
    });
    try {
      const target = await sessions.start({
        headless: true,
        artifactOwner: "owner",
      });
      const abort = new AbortController();
      const pending = await sessions.evaluate(
        "confirm('Stop?')",
        target,
        abort.signal,
        "owner",
      );
      assert.ok("status" in pending && pending.status === "awaiting_dialog");
      abort.abort();
      await assert.rejects(
        sessions.dialog(target, "owner", { action: "inspect" }),
        /Session unavailable/,
      );
    } finally {
      await sessions.shutdown();
    }
  },
);

test(
  "eval returns an early dialog handoff and detects external dismissal with a prearmed monitor",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dialog-eval-")));
    const handlers = new Map<string, Function>();
    const tools = new Map<string, any>();
    let active: string[] = [];
    let browser!: Browser;
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
    const sessions = new ManagedSessions({
      launch: async ({ headless }) => {
        browser = await chromium.launch({ headless });
        return browser;
      },
    });
    const ctx = (owner: string) => ({
      cwd: root,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => owner },
    });
    const call = async (name: string, args: any, owner = "owner") =>
      tools.get(name).execute("id", args, undefined, undefined, ctx(owner));
    try {
      createManagedBrowserExtension(pi as never, {
        loadSettings: async () => ({ values: {} }) as never,
        createSessions: () => sessions,
        createArtifacts: () => new ArtifactStore({ root: join(root, "store") }),
      });
      await handlers.get("session_start")!({}, ctx("owner"));
      const target = await sessions.start({
        headless: true,
        artifactOwner: "owner",
      });
      await sessions.navigate(
        "data:text/html,hello",
        target,
        undefined,
        30000,
        "owner",
      );
      const start = Date.now();
      const pending = JSON.parse(
        (
          await call("browser_eval", {
            ...target,
            code: "prompt('Question','start')",
          })
        ).content[0].text,
      );
      assert.equal(pending.status, "awaiting_dialog");
      assert.ok(Date.now() - start < 2000);
      assert.equal(pending.dialog.type, "prompt");
      await assert.rejects(
        call("browser_dialog", { ...target, action: "refresh" }, "foreign"),
        /Session unavailable/,
      );
      await call("browser_dialog", {
        ...target,
        action: "accept",
        id: pending.dialog.id,
        promptText: "answer",
      });
      const operation = async (id: string) => {
        for (let i = 0; i < 200; i++) {
          const status = JSON.parse(
            (
              await call("browser_dialog", {
                ...target,
                action: "operation",
                operationId: id,
              })
            ).content[0].text,
          );
          if (status.status === "settled") return status;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Eval did not settle");
      };
      const done = await operation(pending.operationId);
      assert.equal(done.result.text, "answer");
      const ordinary = await call("browser_eval", {
        ...target,
        code: "'regular'",
      });
      assert.match(ordinary.content[0].text, /regular/);
      const page = browser.contexts()[0].pages()[0];
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.enable");
      const external = JSON.parse(
        (await call("browser_eval", { ...target, code: "confirm('External')" }))
          .content[0].text,
      );
      assert.equal(external.status, "awaiting_dialog");
      await cdp.send("Page.handleJavaScriptDialog", { accept: false });
      await cdp.detach();
      const externalResult = await operation(external.operationId);
      assert.equal(externalResult.result.text, "false");
      let refresh: any;
      for (let i = 0; i < 100; i++) {
        refresh = JSON.parse(
          (await call("browser_dialog", { ...target, action: "refresh" }))
            .content[0].text,
        );
        if (refresh.status === "none") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(refresh.status, "none");
      const resumed = await call("browser_eval", { ...target, code: "1" });
      assert.match(resumed.content[0].text, /1/);
      await sessions.stop(target.sessionId, 5000, undefined, "owner");
    } finally {
      await handlers.get("session_shutdown")?.();
      await rm(root, { recursive: true, force: true });
    }
  },
);
