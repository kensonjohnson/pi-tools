import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ManagedSessions } from "./sessions.ts";
import { createManagedBrowserExtension } from "./registration.ts";

class Page extends EventEmitter {
  closed = false;
  isClosed() {
    return this.closed;
  }
  url() {
    return "https://example.test/login?token=secret";
  }
  mainFrame() {
    return this;
  }
  async goto() {
    return null;
  }
  async close() {
    this.closed = true;
    this.emit("close");
  }
}
class Browser extends EventEmitter {
  page = new Page();
  async newContext() {
    return { newPage: async () => this.page };
  }
  async close() {
    await this.page.close();
    this.emit("disconnected");
  }
}

test("handoff resumes only on explicit UI-origin input, remains owner-scoped and pauses one session", async () => {
  const browsers: Browser[] = [];
  const sessions = new ManagedSessions({
    launch: async () => {
      const browser = new Browser();
      browsers.push(browser);
      return browser as never;
    },
  });
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  let active: string[] = [];
  const notices: string[] = [];
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
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createSessions: () => sessions,
  });
  const ctx = (owner = "owner", mode = "tui", hasUI = true) => ({
    cwd: "/tmp",
    isProjectTrusted: () => true,
    hasUI,
    mode,
    ui: { notify: (message: string) => notices.push(message) },
    sessionManager: { getSessionId: () => owner },
  });
  await handlers.get("session_start")!({}, ctx());
  const first = await sessions.start({
    artifactOwner: "owner",
    headless: false,
  });
  const other = await sessions.start({
    artifactOwner: "owner",
    headless: false,
  });
  const headless = await sessions.start({
    artifactOwner: "owner",
    headless: true,
  });
  const call = (args: any, context = ctx()) =>
    tools
      .get("browser_handoff")
      .execute("id", args, undefined, undefined, context);
  const unsupported = JSON.parse(
    (await call({ ...first, action: "pause" }, ctx("owner", "json", false)))
      .content[0].text,
  );
  assert.equal(unsupported.status, "unsupported");
  assert.equal(
    sessions.handoffStatus(first.sessionId, "owner").status,
    "active",
  );
  const headlessResult = JSON.parse(
    (await call({ ...headless, action: "pause" })).content[0].text,
  );
  assert.equal(headlessResult.status, "unsupported");
  assert.match(headlessResult.note, /in-memory state may be lost/);
  await assert.rejects(
    call({ ...first, action: "pause" }, ctx("foreign")),
    /Session unavailable/,
  );
  const pending = JSON.parse(
    (await call({ ...first, action: "pause" })).content[0].text,
  );
  assert.equal(pending.status, "awaiting_human");
  assert.equal("url" in pending, false);
  await assert.rejects(
    sessions.navigate("https://example.test", first, undefined, 1000, "owner"),
    /awaiting human/,
  );
  browsers[0].page.emit("framenavigated", browsers[0].page);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    sessions.handoffStatus(first.sessionId, "owner").status,
    "awaiting_human",
  );
  await sessions.navigate(
    "https://example.test",
    other,
    undefined,
    1000,
    "owner",
  );
  await assert.rejects(
    sessions.dialog(first, "owner", { action: "inspect" }),
    /awaiting human/,
  );
  await assert.rejects(
    tools
      .get("browser_pick")
      .execute(
        "id",
        { ...first, selectionMode: "multiple" },
        undefined,
        undefined,
        ctx(),
      ),
    /awaiting human/,
  );
  const input = handlers.get("input")!;
  const text = `browser-resume ${first.sessionId} ${pending.handoffId}`;
  assert.equal(
    (await input({ source: "extension", text }, ctx())).action,
    "continue",
  );
  assert.equal(
    (await input({ source: "interactive", text }, ctx("owner", "json", false)))
      .action,
    "continue",
  );
  assert.equal(
    (await input({ source: "rpc", text }, ctx("foreign", "rpc"))).action,
    "handled",
  );
  assert.equal(
    sessions.handoffStatus(first.sessionId, "owner").status,
    "awaiting_human",
  );
  assert.equal(
    (await input({ source: "interactive", text }, ctx())).action,
    "continue",
  );
  assert.equal(
    sessions.handoffStatus(first.sessionId, "owner").status,
    "active",
  );
  assert.ok(notices.some((notice) => notice.includes("resumed")));
  const lost = JSON.parse(
    (await call({ ...first, action: "pause" })).content[0].text,
  );
  await browsers[0].page.close();
  const lostInput = `browser-resume ${first.sessionId} ${lost.handoffId}`;
  assert.equal(
    (await input({ source: "rpc", text: lostInput }, ctx("owner", "rpc")))
      .action,
    "handled",
  );
  assert.equal(
    sessions.handoffStatus(first.sessionId, "owner").targetLost,
    true,
  );
  await handlers.get("session_shutdown")!({}, ctx());
  assert.ok(!active.includes("browser_handoff"));
});
