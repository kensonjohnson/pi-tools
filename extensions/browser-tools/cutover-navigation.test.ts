import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ManagedSessions } from "./sessions.ts";
import { createManagedBrowserExtension } from "./registration.ts";

class Page extends EventEmitter {
  current = "about:blank";
  failure: Error | undefined;
  closed = false;
  isClosed() {
    return this.closed;
  }
  url() {
    return this.current;
  }
  async goto(url: string) {
    if (this.failure) throw this.failure;
    this.current = url;
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

test("navigation output and errors do not disclose URL credentials", async () => {
  const browser = new Browser();
  const sessions = new ManagedSessions({
    launch: async () => browser as never,
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
    sessionManager: { getSessionId: () => "owner" },
  };
  try {
    createManagedBrowserExtension(pi as never, {
      loadSettings: async () => ({ values: {} }) as never,
      createSessions: () => sessions,
    });
    await handlers.get("session_start")!({}, ctx);
    const target = await sessions.start({ artifactOwner: "owner" });
    const url =
      "https://user:password@example.invalid/path?token=SECRET&view=ok#PRIVATE";
    const call = (value: string) =>
      tools
        .get("browser_navigate")
        .execute("id", { ...target, url: value }, undefined, undefined, ctx);
    const result = JSON.parse((await call(url)).content[0].text);
    assert.match(result.url, /view=ok/);
    assert.doesNotMatch(JSON.stringify(result), /user|password|SECRET|PRIVATE/);
    assert.doesNotMatch(
      JSON.stringify(sessions.list("owner")),
      /user|password|SECRET|PRIVATE/,
    );
    const data = JSON.parse(
      (await call("data:text/html,private-data")).content[0].text,
    );
    assert.equal(data.url, "[non-HTTP URL omitted]");
    assert.doesNotMatch(JSON.stringify(sessions.list("owner")), /private-data/);
    for (const [failure, kind] of [
      [
        Object.assign(
          new Error(`page.goto: Timeout 100ms exceeded visiting ${url}`),
          { name: "TimeoutError" },
        ),
        /timed out/,
      ],
      [
        new Error(`page.goto: net::ERR_NAME_NOT_RESOLVED at ${url}`),
        /network error/,
      ],
      [new Error(`page.goto failed at ${url}`), /Navigation failed/],
    ] as const) {
      browser.page.failure = failure;
      await assert.rejects(call(url), (error: Error) => {
        assert.match(error.message, kind);
        assert.match(error.message, /No retry/);
        assert.doesNotMatch(
          JSON.stringify(error, Object.getOwnPropertyNames(error)),
          /user|password|SECRET|PRIVATE/,
        );
        return true;
      });
    }
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
  }
});
