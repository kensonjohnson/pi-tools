import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore } from "./artifacts.ts";
import { createManagedBrowserExtension } from "./registration.ts";

test("body artifact preserves bytes, ownership, quota and cancellation", async () => {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "body-registration-")),
  );
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
    on(n: string, f: Function) {
      handlers.set(n, f);
    },
    registerTool(t: any) {
      tools.set(t.name, t);
      active.push(t.name);
    },
    getActiveTools: () => active,
    setActiveTools(v: string[]) {
      active = v;
    },
  };
  const page = new EventEmitter(),
    target = { sessionId: "s", tabId: "t" };
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createArtifacts: () =>
      new ArtifactStore({ root: join(parent, "store"), quota: 4 }),
    createInstaller: () => ({}) as never,
    createSessions: (d) => {
      d!.attach(target, page as any);
      return {
        authorize: (address: typeof target, owner: string) => {
          if (
            owner !== "one" ||
            address.sessionId !== target.sessionId ||
            address.tabId !== target.tabId
          )
            throw new Error("Session unavailable.");
        },
        shutdown: async () => ({ complete: true }),
      } as never;
    },
  });
  const ctx = (id: string) => ({
    cwd: parent,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => id },
  });
  try {
    await handlers.get("session_start")!({}, ctx("one"));
    const req = {
      method: () => "POST",
      url: () => "http://localhost/",
      resourceType: () => "fetch",
      frame: () => ({ url: () => "http://localhost/" }),
      redirectedFrom: () => null,
      allHeaders: async () => ({}),
      postDataBuffer: () => Buffer.from([0, 255, 13, 42]),
    };
    page.emit("request", req);
    const history = JSON.parse(
      (
        await tools
          .get("browser_diagnostics")
          .execute("x", { ...target, action: "read" })
      ).content[0].text,
    );
    const args = {
      ...target,
      action: "artifact",
      requestId: history.requests[0].id,
      direction: "request",
    };
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(
      tools
        .get("browser_diagnostic_body")
        .execute("x", args, ctl.signal, undefined, ctx("one")),
      /cancel/i,
    );
    const saved = JSON.parse(
      (
        await tools
          .get("browser_diagnostic_body")
          .execute("x", args, undefined, undefined, ctx("one"))
      ).content[0].text,
    );
    const id = saved.artifact.id;
    const read = async (offset: number, context = ctx("one")) =>
      JSON.parse(
        (
          await tools
            .get("browser_artifact")
            .execute(
              "x",
              { action: "read_binary", id, offset, maxBytes: 2 },
              undefined,
              undefined,
              context,
            )
        ).content[0].text,
      );
    const a = await read(0),
      b = await read(a.nextOffset);
    assert.deepEqual(
      Buffer.concat([
        Buffer.from(a.data, "base64"),
        Buffer.from(b.data, "base64"),
      ]),
      Buffer.from([0, 255, 13, 42]),
    );
    await assert.rejects(read(0, ctx("two")), /owned by another/);
    await assert.rejects(
      tools
        .get("browser_diagnostic_body")
        .execute("x", args, undefined, undefined, ctx("one")),
      /quota/i,
    );
    await handlers.get("session_shutdown")!();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
