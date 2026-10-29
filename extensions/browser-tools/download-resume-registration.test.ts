import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedSessions } from "./sessions.ts";
import { createManagedBrowserExtension } from "./registration.ts";
import { ArtifactStore } from "./artifacts.ts";

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

test("only the owner can explicitly opt back into capture after handoff", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "resume-capture-")));
  const browser = new Browser();
  let sessions!: ManagedSessions;
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
  const ctx = (owner = "owner") => ({
    cwd: root,
    isProjectTrusted: () => true,
    hasUI: true,
    mode: "tui",
    ui: { notify() {} },
    sessionManager: { getSessionId: () => owner },
  });
  const call = (name: string, args: any, owner = "owner") =>
    tools.get(name).execute("id", args, undefined, undefined, ctx(owner));
  try {
    createManagedBrowserExtension(pi as never, {
      loadSettings: async () =>
        ({
          values: { "browser-tools": { diagnosticsEnabled: false } },
        }) as never,
      createArtifacts: () =>
        new ArtifactStore({ root: join(root, "artifacts") }),
      createSessions: (_diagnostics, downloads) => {
        sessions = new ManagedSessions({
          launch: async () => browser as never,
          downloads,
        });
        return sessions;
      },
    });
    await handlers.get("session_start")!({}, ctx());
    const target = await sessions.start({
      artifactOwner: "owner",
      headless: false,
    });
    const status = async (owner = "owner") =>
      JSON.parse(
        (
          await call(
            "browser_download",
            { action: "capture_status", sessionId: target.sessionId },
            owner,
          )
        ).content[0].text,
      );
    assert.equal((await status()).state, "enabled");
    const pause = JSON.parse(
      (await call("browser_handoff", { ...target, action: "pause" })).content[0]
        .text,
    );
    assert.equal((await status()).state, "suspended");
    await assert.rejects(
      call("browser_download", {
        action: "resume_capture",
        sessionId: target.sessionId,
        acknowledgeRisk: true,
      }),
      /awaiting human/,
    );
    await assert.rejects(status("foreign"), /owned by another/);
    await handlers.get("input")!(
      {
        source: "rpc",
        text: `browser-resume ${target.sessionId} ${pause.handoffId}`,
      },
      { ...ctx(), mode: "rpc" },
    );
    assert.equal((await status()).state, "suspended");
    await assert.rejects(
      call(
        "browser_download",
        {
          action: "resume_capture",
          sessionId: target.sessionId,
          acknowledgeRisk: true,
        },
        "foreign",
      ),
      /owned by another/,
    );
    await assert.rejects(
      call("browser_download", {
        action: "resume_capture",
        sessionId: target.sessionId,
      }),
      /acknowledgeRisk=true/,
    );
    const resumed = JSON.parse(
      (
        await call("browser_download", {
          action: "resume_capture",
          sessionId: target.sessionId,
          acknowledgeRisk: true,
        })
      ).content[0].text,
    );
    assert.equal(resumed.state, "enabled");
    assert.match(resumed.warning, /Delayed downloads initiated by a human/);
    assert.equal((await status()).state, "enabled");
    browser.page.emit("download", {
      url: () => "https://example.test/file",
      suggestedFilename: () => "file.txt",
      failure: async () => null,
      createReadStream: async () => Readable.from([Buffer.from("agent")]),
      cancel: async () => {},
      delete: async () => {},
    });
    const list = JSON.parse(
      (
        await call("browser_download", {
          action: "list",
          sessionId: target.sessionId,
        })
      ).content[0].text,
    );
    assert.equal(list.capture.state, "enabled");
    const saved = JSON.parse(
      (
        await call("browser_download", {
          action: "wait",
          sessionId: target.sessionId,
          id: list.downloads[0].id,
        })
      ).content[0].text,
    );
    assert.equal(saved.state, "complete");
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx());
    await rm(root, { recursive: true, force: true });
  }
});
