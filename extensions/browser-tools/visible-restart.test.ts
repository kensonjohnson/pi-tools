import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProfile } from "./profiles.ts";
import { ManagedSessions } from "./sessions.ts";
import { createManagedBrowserExtension } from "./registration.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Page extends EventEmitter {
  closed = false;
  navigations = 0;
  isClosed() {
    return this.closed;
  }
  url() {
    return "about:blank";
  }
  mainFrame() {
    return this;
  }
  async goto() {
    this.navigations++;
    return null;
  }
  async close() {
    this.closed = true;
    this.emit("close");
  }
}
class Browser extends EventEmitter {
  connected = true;
  isConnected() {
    return this.connected;
  }
}
class Context {
  page = new Page();
  browserHandle = new Browser();
  private gate?: Promise<void>;
  constructor(gate?: Promise<void>) {
    this.gate = gate;
  }
  browser() {
    return this.browserHandle;
  }
  pages() {
    return [this.page];
  }
  async close() {
    await this.gate;
    await this.page.close();
    this.browserHandle.connected = false;
    this.browserHandle.emit("disconnected");
  }
}

test(
  "only direct user consent transfers the continuous named-profile lease and invalidates old targets",
  { timeout: 15000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "visible-restart-")),
    );
    const closeGate = deferred(),
      launchGate = deferred(),
      launched = deferred();
    const contexts: Context[] = [];
    const modes: boolean[] = [];
    const sessions = new ManagedSessions({
      launch: async () => {
        throw new Error("unexpected");
      },
      profileRoot: root,
      launchPersistent: async (_path, options) => {
        modes.push(options.headless);
        if (modes.length === 2) {
          launched.resolve();
          await launchGate.promise;
        }
        const context = new Context(
          modes.length === 1 ? closeGate.promise : undefined,
        );
        contexts.push(context);
        return context as never;
      },
    });
    const handlers = new Map<string, Function>(),
      tools = new Map<string, any>();
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
    const ctx = (owner = "owner", mode = "tui", hasUI = true) => ({
      cwd: root,
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
      const old = await sessions.start({
        profile: "test",
        headless: true,
        artifactOwner: "owner",
      });
      const call = (args: any, context = ctx()) =>
        tools
          .get("browser_handoff")
          .execute("id", args, undefined, undefined, context);
      assert.equal(
        JSON.parse(
          (
            await call(
              { ...old, action: "request_visible_restart" },
              ctx("owner", "json", false),
            )
          ).content[0].text,
        ).status,
        "unsupported",
      );
      await assert.rejects(
        call({ ...old, action: "request_visible_restart" }, ctx("foreign")),
        /Session unavailable/,
      );
      const request = JSON.parse(
        (await call({ ...old, action: "request_visible_restart" })).content[0]
          .text,
      );
      assert.equal(request.status, "awaiting_restart_consent");
      assert.match(request.warning, /Unsaved forms.*in-memory/);
      await assert.rejects(
        sessions.navigate(
          "https://example.test",
          old,
          undefined,
          1000,
          "owner",
        ),
        /awaiting human/,
      );
      const input = handlers.get("input")!;
      const consent = `browser-visible-restart ${old.sessionId} ${request.restartId}`;
      assert.equal(
        (await input({ source: "extension", text: consent }, ctx())).action,
        "continue",
      );
      assert.equal(
        (
          await input(
            {
              source: "interactive",
              text: `browser-resume ${old.sessionId} ${request.restartId}`,
            },
            ctx(),
          )
        ).action,
        "handled",
      );
      assert.equal(contexts.length, 1);
      assert.equal(
        (await input({ source: "rpc", text: consent }, ctx("foreign", "rpc")))
          .action,
        "handled",
      );
      assert.equal(contexts.length, 1);
      const pending = input({ source: "interactive", text: consent }, ctx());
      await new Promise((resolve) => setImmediate(resolve));
      await assert.rejects(
        sessions.content(old, undefined, "owner"),
        /Session unavailable/,
      );
      await assert.rejects(
        acquireProfile("test", { root, timeoutMs: 100 }),
        /timed out/,
      );
      closeGate.resolve();
      await launched.promise;
      await assert.rejects(
        acquireProfile("test", { root, timeoutMs: 100 }),
        /timed out/,
      );
      const source = `import { acquireProfile } from ${JSON.stringify(new URL("./profiles.ts", import.meta.url).href)}; try { const lease = await acquireProfile("test", { root: ${JSON.stringify(root)}, timeoutMs: 150 }); await lease.release(); process.exit(1); } catch { process.exit(0); }`;
      const contender = spawn(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", source],
        { stdio: "ignore" },
      );
      const [exitCode] = await once(contender, "exit");
      assert.equal(
        exitCode,
        0,
        "another process must not acquire the lease during restart",
      );
      launchGate.resolve();
      assert.equal((await pending).action, "continue");
      const result: any = sessions.handoffStatus(old.sessionId, "owner");
      assert.equal(result.status, "ready");
      assert.notEqual(result.target.sessionId, old.sessionId);
      assert.notEqual(result.target.tabId, old.tabId);
      assert.deepEqual(modes, [true, false]);
      assert.equal(
        contexts[0].page.navigations + contexts[1].page.navigations,
        0,
      );
      assert.equal(
        sessions.handoffStatus(result.target.sessionId, "owner").status,
        "awaiting_human",
      );
      await assert.rejects(
        sessions.content(result.target, undefined, "owner"),
        /awaiting human/,
      );
      assert.ok(notices.some((text) => text.includes("Visible browser ready")));
      assert.equal(
        (
          await input(
            {
              source: "extension",
              text: `browser-resume ${result.target.sessionId} ${result.handoffId}`,
            },
            ctx(),
          )
        ).action,
        "continue",
      );
      assert.equal(
        sessions.handoffStatus(result.target.sessionId, "owner").status,
        "awaiting_human",
      );
      await sessions.stop(result.target.sessionId, 5000, undefined, "owner");
      assert.equal(
        (sessions.handoffStatus(old.sessionId, "owner") as any).status,
        "unavailable",
      );
      const lease = await acquireProfile("test", { root, timeoutMs: 1000 });
      await lease.release();
    } finally {
      closeGate.resolve();
      launchGate.resolve();
      await handlers.get("session_shutdown")?.({}, ctx());
      await rm(root, { recursive: true, force: true });
    }
  },
);
