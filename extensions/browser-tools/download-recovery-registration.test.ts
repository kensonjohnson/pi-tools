import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { ArtifactStore } from "./artifacts.ts";
import { createManagedBrowserExtension } from "./registration.ts";

test("registered native export is owner-scoped and survives artifact quota failure", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-reg-")));
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
    on: (n: string, f: Function) => handlers.set(n, f),
    registerTool: (t: any) => {
      tools.set(t.name, t);
      active.push(t.name);
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
  };
  const page = new EventEmitter();
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createArtifacts: () =>
      new ArtifactStore({ root: join(root, "store"), quota: 2 }),
    createSessions: (_diagnostics, manager) => {
      manager.attach({ sessionId: "s", tabId: "t" }, page, "owner");
      return {
        assertSessionNotPaused() {},
        shutdown: async () => {
          await manager.endSession("s");
          return { complete: true };
        },
      } as never;
    },
  });
  const ctx = (id: string) => ({
    cwd: root,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => id },
  });
  const call = async (name: string, args: unknown, owner = "owner") =>
    JSON.parse(
      (
        await tools
          .get(name)
          .execute("id", args, undefined, undefined, ctx(owner))
      ).content[0].text,
    );
  let deleted = 0;
  try {
    await handlers.get("session_start")!({}, ctx("owner"));
    page.emit("download", {
      url: () => "https://example.test/file",
      suggestedFilename: () => "a.bin",
      failure: async () => null,
      createReadStream: async () => Readable.from([Buffer.from("abc")]),
      cancel: async () => {},
      delete: async () => {
        deleted++;
      },
    });
    const list = await call("browser_download", {
      action: "list",
      sessionId: "s",
    });
    const id = list.downloads[0].id;
    const failed = await call("browser_download", {
      action: "wait",
      sessionId: "s",
      id,
    });
    assert.equal(failed.nativeRecovery, "available_until_session_close");
    const path = join(root, "export.bin");
    await assert.rejects(
      call(
        "browser_download",
        { action: "export_native", sessionId: "s", id, path },
        "other",
      ),
      /owned by another/,
    );
    const result = await call("browser_download", {
      action: "export_native",
      sessionId: "s",
      id,
      path,
    });
    assert.equal(result.status, "complete");
    assert.equal(await readFile(path, "utf8"), "abc");
    assert.equal(deleted, 0);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx("owner"));
    await rm(root, { recursive: true, force: true });
  }
});
