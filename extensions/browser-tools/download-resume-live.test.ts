import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "playwright";
import { ManagedSessions } from "./sessions.ts";
import { createManagedBrowserExtension } from "./registration.ts";
import { ArtifactStore } from "./artifacts.ts";

test(
  "owner explicitly opts into capture and a delayed human download can then be retained",
  {
    skip:
      process.env.BROWSER_HEADED !== "1" ||
      !existsSync(chromium.executablePath()),
    timeout: 30000,
  },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "download-resume-")),
    );
    let arrived!: () => void, release!: () => void;
    const pendingRequest = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response.setHeader("content-type", "text/html");
        response.end(`<a id="human" href="/file">Download</a>`);
        return;
      }
      if (request.url === "/file") {
        arrived();
        release = () => {
          response.setHeader(
            "content-disposition",
            "attachment; filename=human.txt",
          );
          response.end("human-delayed");
        };
        return;
      }
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    let browser!: Browser, sessions!: ManagedSessions;
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
            launch: async ({ headless }) => {
              browser = await chromium.launch({ headless });
              return browser;
            },
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
      await sessions.navigate(
        `http://127.0.0.1:${(server.address() as any).port}/`,
        target,
        undefined,
        30000,
        "owner",
      );
      const handoff = JSON.parse(
        (await call("browser_handoff", { ...target, action: "pause" }))
          .content[0].text,
      );
      const whilePaused = JSON.parse(
        (
          await call("browser_download", {
            action: "capture_status",
            sessionId: target.sessionId,
          })
        ).content[0].text,
      );
      assert.equal(whilePaused.state, "suspended");
      await assert.rejects(
        call("browser_download", {
          action: "resume_capture",
          sessionId: target.sessionId,
          acknowledgeRisk: true,
        }),
        /awaiting human/,
      );
      const page = browser.contexts()[0].pages()[0];
      await page.evaluate(() =>
        (document.querySelector("#human") as HTMLAnchorElement).click(),
      );
      await pendingRequest;
      await handlers.get("input")!(
        {
          source: "interactive",
          text: `browser-resume ${target.sessionId} ${handoff.handoffId}`,
        },
        ctx(),
      );
      assert.equal(
        JSON.parse(
          (
            await call("browser_download", {
              action: "capture_status",
              sessionId: target.sessionId,
            })
          ).content[0].text,
        ).state,
        "suspended",
      );
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
      assert.equal(
        JSON.parse(
          (
            await call("browser_download", {
              action: "capture_status",
              sessionId: target.sessionId,
            })
          ).content[0].text,
        ).state,
        "enabled",
      );
      assert.equal(
        (sessions.handoffStatus(target.sessionId, "owner") as any).downloadGap
          .captureRestored,
        true,
      );
      const received = page.waitForEvent("download", { timeout: 5000 });
      release();
      await received;
      const list = JSON.parse(
        (
          await call("browser_download", {
            action: "list",
            sessionId: target.sessionId,
          })
        ).content[0].text,
      );
      assert.equal(list.downloads.length, 1);
      const complete = JSON.parse(
        (
          await call("browser_download", {
            action: "wait",
            sessionId: target.sessionId,
            id: list.downloads[0].id,
          })
        ).content[0].text,
      );
      assert.equal(complete.state, "complete");
      const chunk = JSON.parse(
        (
          await call("browser_artifact", {
            action: "read_binary",
            id: complete.artifact.id,
          })
        ).content[0].text,
      );
      assert.equal(
        Buffer.from(chunk.data, "base64").toString(),
        "human-delayed",
      );
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx());
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
