import { test } from "node:test";
import assert from "node:assert/strict";
import { launchFixtureBrowser } from "./download-test-helper.ts";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../extensions/browser-tools/artifacts.ts";
import { ManagedSessions } from "../../extensions/browser-tools/sessions.ts";
import { createManagedBrowserExtension } from "../../extensions/browser-tools/registration.ts";

test(
  "registered download and binary artifact tools work through owned live context",
  { timeout: 30000 },
  async () => {
    const dir = await realpath(
      await mkdtemp(join(tmpdir(), "download-live-registration-")),
    );
    const tools = new Map<string, any>(),
      handlers = new Map<string, Function>();
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
    const context = {
      cwd: dir,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "owner" },
    };
    let fixture: Awaited<ReturnType<typeof launchFixtureBrowser>> | undefined;
    createManagedBrowserExtension(pi as never, {
      loadSettings: async () => ({ values: {} }) as never,
      createArtifacts: () => new ArtifactStore({ root: join(dir, "store") }),
      createInstaller: () => ({ ensure: async () => ({ ok: true }) }) as never,
      createSessions: (diagnostics, downloads) =>
        new ManagedSessions({
          launch: async ({ headless }) => {
            fixture = await launchFixtureBrowser(headless);
            return fixture.browser;
          },
          diagnostics,
          downloads,
        }),
    });
    const call = async (name: string, args: any) =>
      JSON.parse(
        (
          await tools
            .get(name)
            .execute("id", args, undefined, undefined, context)
        ).content[0].text,
      );
    try {
      await handlers.get("session_start")!({}, context);
      const target = await call("browser_session", {
        action: "start",
        headless: process.env.BROWSER_HEADED !== "1",
      });
      await call("browser_navigate", {
        ...target,
        url: "data:text/html,<html><body></body></html>",
      });
      await call("browser_eval", {
        ...target,
        code: `(() => { const a=document.createElement('a'); a.download='x.bin'; a.href=URL.createObjectURL(new Blob([new Uint8Array([0,255,42])])); document.body.append(a); a.click(); return true; })()`,
      });
      let items: any[] = [];
      for (let i = 0; i < 100 && !items.length; i++) {
        items = (
          await call("browser_download", {
            action: "list",
            sessionId: target.sessionId,
          })
        ).downloads;
        if (!items.length)
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(items.length, 1);
      const download = await call("browser_download", {
        action: "wait",
        sessionId: target.sessionId,
        id: items[0].id,
        timeoutMs: 5000,
      });
      assert.equal(download.state, "complete");
      await call("browser_session", {
        action: "stop",
        sessionId: target.sessionId,
      });
      const chunk = await call("browser_artifact", {
        action: "read_binary",
        id: download.artifact.id,
      });
      assert.deepEqual(
        Buffer.from(chunk.data, "base64"),
        Buffer.from([0, 255, 42]),
      );
    } finally {
      try {
        await handlers.get("session_shutdown")?.();
      } finally {
        await fixture?.close();
        await rm(dir, { recursive: true, force: true });
      }
    }
  },
);
