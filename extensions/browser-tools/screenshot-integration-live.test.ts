import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";
import { createManagedBrowserExtension } from "./registration.ts";
import { ArtifactStore } from "./artifacts.ts";

test(
  "registered screenshots return images and owned artifacts for viewport, page and frame refs",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "browser-screenshot-integration-")),
    );
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
      on: (n: string, fn: Function) => handlers.set(n, fn),
      registerTool: (tool: any) => tools.set(tool.name, tool),
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => {
        active = names;
      },
    };
    const sessions = new ManagedSessions({
      launch: ({ headless }) => chromium.launch({ headless }),
    });
    const ctx = (id: string) => ({
      cwd: root,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => id },
    });
    const call = (
      name: string,
      args: any,
      owner = "owner",
      signal?: AbortSignal,
    ) => tools.get(name).execute("id", args, signal, undefined, ctx(owner));
    try {
      createManagedBrowserExtension(pi as never, {
        loadSettings: async () => ({ values: {} }) as never,
        createSessions: () => sessions,
        createArtifacts: () => new ArtifactStore({ root: join(root, "store") }),
      });
      await handlers.get("session_start")!({}, ctx("owner"));
      assert.ok(
        active.includes("browser_screenshot") &&
          active.includes("browser_viewport"),
      );
      const target = await sessions.start({
        headless: true,
        artifactOwner: "owner",
      });
      const html = `<div style="height:1200px">Main</div><iframe id="frame" srcdoc="<button id='child'>Child</button>"></iframe>`;
      await sessions.navigate(
        `data:text/html,${encodeURIComponent(html)}`,
        target,
        undefined,
        30000,
        "owner",
      );
      const custom = JSON.parse(
        (
          await call("browser_viewport", {
            ...target,
            choice: { width: 640, height: 480 },
          })
        ).content[0].text,
      );
      assert.equal(custom.width, 640);
      assert.equal(custom.height, 480);
      await assert.rejects(
        call("browser_viewport", {
          ...target,
          choice: { width: 10000, height: 100 },
        }),
        /capture limit exceeded/,
      );
      const viewport = JSON.parse(
        (
          await call("browser_viewport", {
            ...target,
            choice: { preset: "phone" },
          })
        ).content[0].text,
      );
      assert.equal(viewport.width, 390);
      assert.match(viewport.note, /not emulated/);
      await assert.rejects(
        call(
          "browser_viewport",
          { ...target, choice: { width: 100, height: 100 } },
          "foreign",
        ),
        /Session unavailable/,
      );
      const screen = await call("browser_screenshot", { ...target });
      const meta = JSON.parse(screen.content[0].text);
      assert.equal(screen.content[1].type, "image");
      assert.equal(screen.content[1].mimeType, "image/png");
      assert.equal(meta.width, 390);
      assert.equal(meta.resolution, "original");
      assert.ok(meta.artifact.id);
      assert.ok(!JSON.stringify(meta).includes(root));
      assert.equal(screen.details, undefined);
      await assert.rejects(
        call("browser_screenshot", { ...target }, "foreign"),
        /Session unavailable/,
      );
      await assert.rejects(
        call(
          "browser_artifact",
          { action: "read_binary", id: meta.artifact.id },
          "foreign",
        ),
        /owned by another/,
      );
      const exportPath = join(root, "image.png");
      await call("browser_artifact", {
        action: "export",
        id: meta.artifact.id,
        path: exportPath,
      });
      assert.deepEqual(
        await readFile(exportPath),
        Buffer.from(screen.content[1].data, "base64"),
      );
      const full = JSON.parse(
        (await call("browser_screenshot", { ...target, scope: "fullPage" }))
          .content[0].text,
      );
      assert.ok(full.height > meta.height);
      const snapshot = await sessions.snapshot(target, "owner", undefined, {
        frameSelector: "#frame",
        selector: "#child",
      });
      const ref = snapshot.snapshot.records.find((record) => record.ref)?.ref;
      assert.ok(ref);
      const element = await call("browser_screenshot", {
        ...target,
        scope: "element",
        ref,
      });
      assert.equal(element.content[1].type, "image");
      assert.equal(JSON.parse(element.content[0].text).scope, "element");
      await sessions.navigate(
        "data:text/html,changed",
        target,
        undefined,
        30000,
        "owner",
      );
      await assert.rejects(
        call("browser_screenshot", { ...target, scope: "element", ref }),
        /Stale reference/,
      );
    } finally {
      await handlers.get("session_shutdown")?.();
      await rm(root, { recursive: true, force: true });
    }
  },
);
