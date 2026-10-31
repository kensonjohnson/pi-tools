import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "./artifacts.ts";
import { createManagedBrowserExtension } from "./registration.ts";
import type { DownloadManager } from "./downloads.ts";

test("download list returns all records as a private artifact beyond four active and 100 records", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "download-scale-")));
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
  let downloads: DownloadManager;
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createArtifacts: () => new ArtifactStore({ root: join(root, "store") }),
    createSessions: (_diagnostics, manager) => {
      downloads = manager;
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
  try {
    await handlers.get("session_start")!({}, ctx("owner"));
    for (let i = 0; i < 150; i++)
      page.emit("download", {
        url: () => `https://example.test/file-${i}`,
        suggestedFilename: () => `file-${i}.bin`,
        failure: () => new Promise(() => {}),
        createReadStream: async () => null,
        cancel: async () => {},
        delete: async () => {},
      });
    assert.equal(downloads!.list("s").length, 150);
    assert.equal(downloads!.saturation("s").rejected, 0);
    const list = await call("browser_download", {
      action: "list",
      sessionId: "s",
    });
    assert.equal(list.complete, false);
    await assert.rejects(
      call(
        "browser_artifact",
        { action: "read", id: list.artifact.id },
        "other",
      ),
      /owned by another/,
    );
    await assert.rejects(
      call("browser_download", { action: "list", sessionId: "s" }, "other"),
      /owned by another/,
    );
    let offset = 0,
      data = "";
    for (;;) {
      const chunk = await call("browser_artifact", {
        action: "read",
        id: list.artifact.id,
        offset,
      });
      data += chunk.text;
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    }
    const parsed = JSON.parse(data);
    assert.equal(parsed.downloads.length, 150);
    assert.equal(parsed.omitted, 0);
    assert.equal(parsed.saturation.evicted, 0);
    assert.equal(parsed.downloads[0].suggestedName, "file-0.bin");
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx("owner"));
    await rm(root, { recursive: true, force: true });
  }
});
