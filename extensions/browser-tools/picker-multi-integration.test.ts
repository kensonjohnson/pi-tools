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
    return "about:blank";
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

test("multi-picker finishes only from owner UI input and disposes all handles", async () => {
  const browsers: Browser[] = [];
  let called = 0,
    disposed = 0,
    finished = false;
  const sessions = new ManagedSessions({
    launch: async () => {
      const b = new Browser();
      browsers.push(b);
      return b as never;
    },
    picker: async ({ finishSignal, maxSelections }) => {
      called++;
      assert.equal(maxSelections, 3);
      await new Promise<void>((resolve) => {
        finishSignal!.addEventListener(
          "abort",
          () => {
            finished = true;
            resolve();
          },
          { once: true },
        );
      });
      const handle = () => ({
        isConnected: async () => true,
        dispose: async () => {
          disposed++;
        },
      });
      const a = handle(),
        b = handle();
      return {
        status: "selected",
        handle: a as never,
        nodeName: "INPUT",
        selections: [
          {
            handle: a as never,
            metadata: {
              tag: "input",
              id: "form",
              classes: ["field"],
              text: "",
              parent: {
                tag: "div",
                id: "host",
                classes: ["group"],
                relation: "shadow-host",
                value: "parent-private",
              },
              summary: '<input id="form" class="field"></input>',
              summaryTruncated: false,
              summaryOmissions: [
                "other attributes and values",
                "descendant markup",
                "hidden and sensitive content",
              ],
              value: "should-not-leak",
            } as never,
          },
          {
            handle: b as never,
            metadata: {
              tag: "button",
              id: "submit",
              classes: [],
              text: "Submit",
              parent: null,
              summary: '<button id="submit">Submit</button>',
              summaryTruncated: true,
              summaryOmissions: [
                "other attributes and values",
                "descendant markup",
                "hidden and sensitive content",
              ],
            },
          },
        ],
      };
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
  const ctx = (owner = "owner", mode = "tui", hasUI = true) => ({
    cwd: "/tmp",
    isProjectTrusted: () => true,
    hasUI,
    mode,
    ui: { notify: (text: string) => notices.push(text) },
    sessionManager: { getSessionId: () => owner },
  });
  try {
    createManagedBrowserExtension(pi as never, {
      loadSettings: async () => ({ values: {} }) as never,
      createSessions: () => sessions,
    });
    await handlers.get("session_start")!({}, ctx());
    const target = await sessions.start({
      headless: false,
      artifactOwner: "owner",
    });
    const noUI = await tools
      .get("browser_pick")
      .execute(
        "id",
        { ...target, maxSelections: 3 },
        undefined,
        undefined,
        ctx("owner", "json", false),
      );
    assert.match(noUI.content[0].text, /unsupported/);
    assert.equal(called, 0);
    const pending = tools
      .get("browser_pick")
      .execute(
        "id",
        { ...target, maxSelections: 3 },
        undefined,
        (update: any) => updates.push(update),
        ctx(),
      );
    const progress = JSON.parse(updates[0].content[0].text);
    assert.equal(progress.status, "awaiting_user_selection");
    assert.match(notices[0], /browser-pick-finish/);
    const text = `browser-pick-finish ${target.sessionId} ${progress.pickerId}`;
    const input = handlers.get("input")!;
    assert.equal(
      (await input({ source: "extension", text }, ctx())).action,
      "continue",
    );
    assert.equal(
      (await input({ source: "interactive", text }, ctx("foreign"))).action,
      "handled",
    );
    assert.equal(finished, false);
    await assert.rejects(
      sessions.content(target, undefined, "owner"),
      /Session is busy/,
    );
    assert.equal(
      (await input({ source: "rpc", text }, ctx("owner", "rpc"))).action,
      "handled",
    );
    const value = JSON.parse((await pending).content[0].text);
    assert.equal(value.status, "selected");
    assert.equal(value.actionable, false);
    assert.equal(value.selections.length, 2);
    assert.deepEqual(value.selections[0].parent, {
      tag: "div",
      id: "host",
      classes: ["group"],
      relation: "shadow-host",
    });
    assert.equal(
      value.selections[0].summary,
      '<input id="form" class="field"></input>',
    );
    assert.equal(value.selections[0].summaryTruncated, false);
    assert.deepEqual(value.selections[0].summaryOmissions, [
      "other attributes and values",
      "descendant markup",
      "hidden and sensitive content",
    ]);
    assert.equal(value.selections[1].summaryTruncated, true);
    assert.equal(value.omittedSelectionMetadata, 0);
    assert.match(value.note, /synthetic, not original HTML or a selector/);
    assert.doesNotMatch(
      JSON.stringify(value),
      /should-not-leak|parent-private/,
    );
    assert.equal(disposed, 2);
    assert.equal(
      (await input({ source: "interactive", text }, ctx())).action,
      "handled",
    );
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx());
  }
});

test("normal picker abort cancels without closing a healthy browser", async () => {
  const browser = new Browser();
  let disposed = 0;
  const sessions = new ManagedSessions({
    launch: async () => browser as never,
    picker: async ({ signal }) => {
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      const handle = {
        isConnected: async () => true,
        dispose: async () => {
          disposed++;
        },
      };
      return {
        status: "selected",
        handle: handle as never,
        nodeName: "BUTTON",
        selections: [
          {
            handle: handle as never,
            metadata: { tag: "button", id: "", classes: [], text: "" },
          },
        ],
      };
    },
  });
  try {
    const target = await sessions.start({
      headless: false,
      artifactOwner: "owner",
    });
    const abort = new AbortController();
    const pending = sessions.pick(target, "owner", abort.signal);
    abort.abort();
    assert.equal((await pending).status, "cancelled");
    assert.equal(disposed, 1);
    assert.equal(browser.page.closed, false);
    assert.equal(sessions.list("owner").length, 1);
  } finally {
    await sessions.shutdown();
  }
});

test("uncertain picker failure invalidates the session before releasing handles", async () => {
  let disposed = 0;
  const sessions = new ManagedSessions({
    launch: async () => new Browser() as never,
    picker: async ({ onUncertainFailure }) => {
      onUncertainFailure("lost gate");
      const handle = {
        isConnected: async () => true,
        dispose: async () => {
          disposed++;
        },
      };
      return {
        status: "selected",
        handle: handle as never,
        nodeName: "BUTTON",
        selections: [
          {
            handle: handle as never,
            metadata: { tag: "button", id: "", classes: [], text: "" },
          },
        ],
      };
    },
  });
  try {
    const target = await sessions.start({
      headless: false,
      artifactOwner: "owner",
    });
    await assert.rejects(sessions.pick(target, "owner"), /Session closed/);
    assert.equal(disposed, 1);
    await assert.rejects(
      sessions.content(target, undefined, "owner"),
      /Session unavailable/,
    );
  } finally {
    await sessions.shutdown();
  }
});

test("all selected handles are disposed when validation or cleanup fails", async () => {
  for (const fail of ["stale", "dispose"] as const) {
    let disposed = 0;
    const sessions = new ManagedSessions({
      launch: async () => new Browser() as never,
      picker: async () => {
        const handle = (index: number) => ({
          isConnected: async () => fail !== "stale" || index !== 0,
          dispose: async () => {
            disposed++;
            if (fail === "dispose" && index === 0)
              throw new Error("detach failed");
          },
        });
        const a = handle(0),
          b = handle(1);
        return {
          status: "selected",
          handle: a as never,
          nodeName: "BUTTON",
          selections: [a, b].map((h) => ({
            handle: h as never,
            metadata: { tag: "button", id: "", classes: [], text: "" },
          })),
        };
      },
    });
    try {
      const target = await sessions.start({
        headless: false,
        artifactOwner: "owner",
      });
      await assert.rejects(
        sessions.pick(target, "owner", undefined, { maxSelections: 2 }),
        /no longer connected|cleanup could not be verified/,
      );
      assert.equal(disposed, 2);
      await assert.rejects(
        sessions.content(target, undefined, "owner"),
        /Session unavailable/,
      );
    } finally {
      await sessions.shutdown();
    }
  }
});

test("picker tool bounds twenty large metadata records and reports omissions", async () => {
  let disposed = 0;
  const sessions = new ManagedSessions({
    launch: async () => new Browser() as never,
    picker: async () => {
      const items = Array.from({ length: 20 }, () => ({
        handle: {
          isConnected: async () => true,
          dispose: async () => {
            disposed++;
          },
        } as never,
        metadata: {
          tag: "button",
          id: "x".repeat(100),
          classes: Array(10).fill("a".repeat(50)),
          text: "\\u0001".repeat(300),
          parent: {
            tag: "div",
            id: "p".repeat(100),
            classes: Array(10).fill("b".repeat(50)),
            relation: "parent" as const,
          },
          summary: "&amp;".repeat(1000),
          summaryTruncated: false,
          summaryOmissions: [
            "other attributes and values",
            "descendant markup",
            "hidden and sensitive content",
          ],
        },
      }));
      return {
        status: "selected" as const,
        handle: items[0].handle,
        nodeName: "BUTTON",
        selections: items,
      };
    },
  });
  const handlers = new Map<string, Function>(),
    tools = new Map<string, any>();
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
    const raw = (
      await tools
        .get("browser_pick")
        .execute(
          "id",
          { ...target, maxSelections: 20 },
          undefined,
          undefined,
          ctx,
        )
    ).content[0].text;
    const result = JSON.parse(raw);
    assert.ok(Buffer.byteLength(raw) <= 16000);
    assert.equal(result.status, "selected");
    assert.equal(result.selections.length, 20);
    assert.ok(result.omittedSelectionMetadata > 0);
    assert.equal(
      result.omittedSelectionMetadata,
      result.selections.filter((item: any) => item.metadataOmitted).length,
    );
    assert.equal(result.selections[0].summaryTruncated, true);
    assert.equal(disposed, 20);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
  }
});
