import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserDiagnostics } from "./diagnostics.ts";
import { ManagedSessions } from "./sessions.ts";
import { createManagedBrowserExtension } from "./registration.ts";

class Page extends EventEmitter {
  closed = false;
  current = "https://example.test/start";
  isClosed() {
    return this.closed;
  }
  url() {
    return this.current;
  }
  mainFrame() {
    return this;
  }
  async close() {
    this.closed = true;
    this.emit("close");
  }
  log(text: string) {
    this.emit("console", {
      location: () => ({}),
      type: () => "log",
      text: () => text,
    });
  }
}
class Browser extends EventEmitter {
  pages: Page[] = [];
  closed = false;
  async newContext() {
    return {
      newPage: async () => {
        const page = new Page();
        this.pages.push(page);
        return page;
      },
      close: async () => {},
    };
  }
  async close() {
    this.closed = true;
    for (const page of this.pages) if (!page.closed) await page.close();
    this.emit("disconnected");
  }
}

test("handoff hides all paused tab URLs and discards diagnostics until user confirmation", async () => {
  const diagnostics = new BrowserDiagnostics();
  const browsers: Browser[] = [];
  const sessions = new ManagedSessions({
    launch: async () => {
      const browser = new Browser();
      browsers.push(browser);
      return browser as never;
    },
    diagnostics,
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
  const ctx = (owner = "owner") => ({
    cwd: "/tmp",
    isProjectTrusted: () => true,
    hasUI: true,
    mode: "tui",
    ui: { notify: (message: string) => notices.push(message) },
    sessionManager: { getSessionId: () => owner },
  });
  try {
    createManagedBrowserExtension(pi as never, {
      loadSettings: async () => ({ values: {} }) as never,
      createSessions: () => sessions,
    });
    await handlers.get("session_start")!({}, ctx());
    const target = await sessions.start({
      artifactOwner: "owner",
      headless: false,
    });
    const sibling = await sessions.newTab(target.sessionId, undefined, "owner");
    const other = await sessions.start({
      artifactOwner: "other",
      headless: false,
    });
    browsers[0].pages[0].log("before-handoff-secret");
    const pause = await sessions.beginHandoff(target, "owner");
    assert.equal(pause.status, "awaiting_human");
    assert.match(pause.note, /discarded.*during handoff/);
    browsers[0].pages[0].current =
      "https://example.test/callback?code=oauth-private";
    browsers[0].pages[1].current =
      "https://example.test/callback?token=sibling-private";
    browsers[0].pages[0].log("one-time-secret");
    browsers[0].pages[1].log("other-tab-secret");
    browsers[1].pages[0].log("other-owner-visible");
    const listing = await tools
      .get("browser_session")
      .execute("id", { action: "list" }, undefined, undefined, ctx());
    assert.doesNotMatch(
      listing.content[0].text,
      /oauth-private|sibling-private|callback/,
    );
    assert.match(listing.content[0].text, /hidden during human handoff/);
    const foreignListing = await tools
      .get("browser_session")
      .execute("id", { action: "list" }, undefined, undefined, ctx("other"));
    assert.doesNotMatch(
      foreignListing.content[0].text,
      new RegExp(target.sessionId),
    );
    assert.match(
      JSON.stringify(diagnostics.read(other)),
      /other-owner-visible/,
    );
    assert.throws(() => diagnostics.read(target), /unavailable/);
    await handlers.get("input")!(
      {
        source: "interactive",
        text: `browser-resume ${target.sessionId} ${pause.handoffId}`,
      },
      ctx(),
    );
    assert.match(
      notices.at(-1)!,
      /history before and during human handoff was discarded/,
    );
    const first = diagnostics.read(target),
      second = diagnostics.read(sibling);
    assert.doesNotMatch(
      JSON.stringify([first, second]),
      /before-handoff-secret|one-time-secret|other-tab-secret|oauth-private/,
    );
    assert.match(JSON.stringify(first.gaps), /before attachment/);
    browsers[0].pages[0].log("after-resume");
    assert.match(JSON.stringify(diagnostics.read(target)), /after-resume/);
    const resumedList = await tools
      .get("browser_session")
      .execute("id", { action: "list" }, undefined, undefined, ctx());
    assert.doesNotMatch(
      resumedList.content[0].text,
      /oauth-private|sibling-private/,
    );
    assert.match(
      JSON.stringify(sessions.handoffStatus(target.sessionId, "owner")),
      /history before and during human handoff was discarded/,
    );
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx());
  }
});

test("diagnostic suspension or restoration failure invalidates only the owned session", async () => {
  for (const failure of ["suspend", "restore"] as const) {
    const browser = new Browser();
    let attaches = 0;
    const diagnostics = {
      attach: () => {
        attaches++;
        if (failure === "restore" && attaches > 1)
          throw new Error("restore failed");
      },
      endSession: () => {
        if (failure === "suspend") throw new Error("suspend failed");
      },
      detachTab: () => {},
      isCleanupUnverified: () => false,
    };
    const sessions = new ManagedSessions({
      launch: async () => browser as never,
      diagnostics: diagnostics as never,
    });
    const target = await sessions.start({
      artifactOwner: "owner",
      headless: false,
    });
    if (failure === "suspend")
      await assert.rejects(
        sessions.beginHandoff(target, "owner"),
        /suspension could not be verified/,
      );
    else {
      const pending = await sessions.beginHandoff(target, "owner");
      assert.equal(pending.status, "awaiting_human");
      assert.throws(
        () =>
          sessions.confirmHandoff(
            target.sessionId,
            pending.handoffId!,
            "owner",
          ),
        /restoration failed/,
      );
    }
    assert.deepEqual(sessions.list("owner"), []);
    await sessions.shutdown();
  }
});

test("download suspension or restoration failure invalidates the owned session", async () => {
  for (const failure of ["suspend", "restore"] as const) {
    const browser = new Browser();
    const downloads = {
      attach: () => {},
      detach: () => {},
      endSession: async () => ({ cleanup: "complete" }),
      suspendSession: () => {
        if (failure === "suspend") throw new Error("suspend failed");
        return { inFlightBefore: 0, pendingCleanup: 0 };
      },
      suspensionStatus: () => {
        if (failure === "restore") throw new Error("resume failed");
        return { ignored: 0, inFlightBefore: 0, captureRestored: false };
      },
    };
    const sessions = new ManagedSessions({
      launch: async () => browser as never,
      downloads: downloads as never,
    });
    const target = await sessions.start({
      artifactOwner: "owner",
      headless: false,
    });
    if (failure === "suspend")
      await assert.rejects(
        sessions.beginHandoff(target, "owner"),
        /suspension could not be verified/,
      );
    else {
      const pending = await sessions.beginHandoff(target, "owner");
      assert.throws(
        () =>
          sessions.confirmHandoff(
            target.sessionId,
            pending.handoffId!,
            "owner",
          ),
        /restoration failed/,
      );
    }
    assert.deepEqual(sessions.list("owner"), []);
    await sessions.shutdown();
  }
});

test("a dialog left open during handoff prevents confirmation", async () => {
  const browser = new Browser();
  const sessions = new ManagedSessions({
    launch: async () => browser as never,
  });
  try {
    const target = await sessions.start({
      artifactOwner: "owner",
      headless: false,
    });
    const pending = await sessions.beginHandoff(target, "owner");
    browser.pages[0].emit("dialog", {
      type: () => "prompt",
      message: () => "one-time-secret",
      defaultValue: () => "",
      dismiss: async () => {},
      accept: async () => {},
    });
    assert.throws(
      () =>
        sessions.confirmHandoff(target.sessionId, pending.handoffId!, "owner"),
      /dialog is still pending/,
    );
    assert.equal(
      sessions.handoffStatus(target.sessionId, "owner").status,
      "awaiting_human",
    );
    await assert.rejects(
      sessions.dialog(target, "owner", { action: "inspect" }),
      /awaiting human/,
    );
  } finally {
    await sessions.shutdown();
  }
});

test("video-enabled sessions cannot enter a human handoff", async () => {
  const browser = new Browser();
  const videos = {
    prepare: async () => "/tmp/fake-video",
    attach: () => {},
    markUnverified: () => {},
    closed: async () => true,
  };
  const sessions = new ManagedSessions({
    launch: async () => browser as never,
    videos: videos as never,
  });
  try {
    const target = await sessions.start({
      artifactOwner: "owner",
      headless: false,
      video: true,
    });
    await assert.rejects(
      sessions.beginHandoff(target, "owner"),
      /records video/,
    );
    assert.equal(
      sessions.handoffStatus(target.sessionId, "owner").status,
      "active",
    );
  } finally {
    await sessions.shutdown();
  }
});

test("trace-active sessions cannot enter a human handoff", async () => {
  const browser = new Browser();
  const recordings = {
    inspect: () => ({ state: "recording" }),
    endSession: async () => true,
  };
  const sessions = new ManagedSessions({
    launch: async () => browser as never,
    recordings: recordings as never,
  });
  try {
    const target = await sessions.start({
      artifactOwner: "owner",
      headless: false,
    });
    await assert.rejects(
      sessions.beginHandoff(target, "owner"),
      /Stop and finalize the active trace/,
    );
    assert.equal(
      sessions.handoffStatus(target.sessionId, "owner").status,
      "active",
    );
  } finally {
    await sessions.shutdown();
  }
});
