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
  mainFrame() {
    return this;
  }
  async close() {
    this.closed = true;
    this.emit("close");
  }
}
class Browser extends EventEmitter {
  page = new Page();
  closed = false;
  async newContext() {
    return { newPage: async () => this.page };
  }
  async close() {
    this.closed = true;
    await this.page.close();
    this.emit("disconnected");
  }
}

test("registered semantic tools enforce ownership, navigation invalidation, picker cancellation and quarantine", async () => {
  const browser = new Browser();
  let mode: "cancel" | "uncertain" | "selected" = "cancel";
  let disposed = 0;
  let clicks = 0;
  const sessions = new ManagedSessions({
    launch: async () => browser as never,
    makeSnapshots: (page) => {
      let valid = false;
      const invalidate = () => {
        valid = false;
      };
      page.on("framenavigated", invalidate);
      return {
        snapshot: async () => {
          valid = true;
          return { records: [{ ref: "ref" }] };
        },
        resolve: async (ref: string) => {
          if (!valid || ref !== "ref") throw new Error("Stale reference");
          return {
            click: async () => {
              clicks++;
            },
          };
        },
        dispose: async () => {
          valid = false;
          page.off("framenavigated", invalidate);
        },
      } as never;
    },
    picker: async ({ signal, onUncertainFailure }) => {
      if (mode === "uncertain") {
        onUncertainFailure("lost gate");
        return { status: "cancelled", reason: "uncertain" };
      }
      if (mode === "selected")
        return {
          status: "selected",
          nodeName: "BUTTON",
          handle: {
            isConnected: async () => true,
            dispose: async () => {
              disposed++;
            },
          } as never,
        };
      return new Promise((resolve) =>
        signal!.addEventListener(
          "abort",
          () => resolve({ status: "cancelled", reason: "aborted" }),
          { once: true },
        ),
      );
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
    on: (n: string, f: Function) => handlers.set(n, f),
    registerTool: (t: any) => tools.set(t.name, t),
    getActiveTools: () => active,
    setActiveTools: (v: string[]) => {
      active = v;
    },
  };
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createSessions: () => sessions,
  });
  const ctx = (id: string) => ({
    cwd: "/tmp",
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => id },
  });
  await handlers.get("session_start")!({}, ctx("owner"));
  const target = await sessions.start({ artifactOwner: "owner" });
  const call = (
    name: string,
    args: any,
    owner = "owner",
    signal?: AbortSignal,
  ) => tools.get(name).execute("id", args, signal, undefined, ctx(owner));
  assert.ok(active.includes("browser_snapshot"));
  assert.ok(tools.get("browser_snapshot").parameters.properties.frameSelector);
  assert.match(
    tools.get("browser_pick").description,
    /Frame attachment, detachment, or navigation cancels/,
  );
  assert.match(tools.get("browser_pick").description, /non-actionable/);
  assert.doesNotMatch(
    tools.get("browser_pick").description,
    /frames are unsupported/,
  );
  await call("browser_snapshot", target);
  await assert.rejects(
    call("browser_snapshot_ref", { ...target, ref: "ref" }, "foreign"),
    /Session unavailable/,
  );
  await call("browser_snapshot_ref", { ...target, ref: "ref" });
  await call("browser_snapshot_ref", {
    ...target,
    ref: "ref",
    action: "click",
    timeoutMs: 200,
  });
  assert.equal(clicks, 1);
  browser.page.emit("framenavigated", browser.page);
  await assert.rejects(
    call("browser_snapshot_ref", { ...target, ref: "ref" }),
    /Stale reference/,
  );
  const abort = new AbortController();
  const pending = call("browser_pick", target, "owner", abort.signal);
  await assert.rejects(call("browser_snapshot", target), /Session is busy/);
  await assert.rejects(
    call("browser_pick", target, "foreign"),
    /Session unavailable/,
  );
  abort.abort();
  assert.match((await pending).content[0].text, /cancelled/);
  assert.equal(browser.closed, false);
  mode = "selected";
  assert.match(
    (await call("browser_pick", target)).content[0].text,
    /non-actionable|actionable/,
  );
  assert.equal(disposed, 1);
  mode = "uncertain";
  await assert.rejects(call("browser_pick", target), /Session closed/);
  await assert.rejects(call("browser_snapshot", target), /Session unavailable/);
  await handlers.get("session_shutdown")!({}, {});
  assert.equal(active.includes("browser_pick"), false);
});
