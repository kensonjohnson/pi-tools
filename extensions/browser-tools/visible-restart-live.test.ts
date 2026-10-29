import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { ManagedSessions } from "./sessions.ts";
import { BrowserDiagnostics } from "./diagnostics.ts";
import { DownloadManager } from "./downloads.ts";

test(
  "named profile visible restart retains cookie without replaying navigation",
  {
    skip:
      process.env.BROWSER_HEADED !== "1" ||
      !existsSync(chromium.executablePath()),
    timeout: 60000,
  },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "visible-profile-restart-")),
    );
    let hits = 0;
    const server = createServer((_request, response) => {
      hits++;
      response.setHeader(
        "set-cookie",
        "fixture_login=retained; Max-Age=3600; Path=/; SameSite=Lax",
      );
      response.setHeader("content-type", "text/html");
      response.end("<title>fixture</title><input value='transient'>");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const contexts: BrowserContext[] = [];
    const diagnostics = new BrowserDiagnostics();
    const downloads = new DownloadManager({
      sink: {
        putBinary: async () => {
          throw new Error("unexpected artifact");
        },
      },
    });
    const sessions = new ManagedSessions({
      diagnostics,
      downloads,
      launch: ({ headless }) => chromium.launch({ headless }),
      profileRoot: root,
      launchPersistent: async (path, { headless }) => {
        const context = await chromium.launchPersistentContext(path, {
          headless,
        });
        contexts.push(context);
        return context;
      },
    });
    try {
      const target = await sessions.start({
        profile: "fixture",
        headless: true,
        artifactOwner: "owner",
      });
      const url = `http://127.0.0.1:${(server.address() as any).port}/`;
      await sessions.navigate(url, target, undefined, 30000, "owner");
      const oldHits = hits;
      const request: any = sessions.requestVisibleRestart(target, "owner");
      const result = await sessions.confirmVisibleRestart(
        target.sessionId,
        request.restartId,
        "owner",
        AbortSignal.timeout(30000),
      );
      assert.notEqual(result.target.sessionId, target.sessionId);
      assert.equal(
        sessions.handoffStatus(result.target.sessionId, "owner").status,
        "awaiting_human",
      );
      await contexts[1]
        .pages()[0]
        .evaluate(() => console.log("handoff-private"));
      assert.throws(() => diagnostics.read(result.target), /unavailable/);
      assert.equal(
        downloads.captureStatus(result.target.sessionId, "owner").state,
        "suspended",
      );
      sessions.confirmHandoff(
        result.target.sessionId,
        result.handoffId,
        "owner",
      );
      assert.doesNotMatch(
        JSON.stringify(diagnostics.read(result.target)),
        /handoff-private/,
      );
      assert.equal(
        downloads.captureStatus(result.target.sessionId, "owner").state,
        "suspended",
      );
      assert.equal(
        (await contexts[1].cookies(url)).find(
          (cookie) => cookie.name === "fixture_login",
        )?.value,
        "retained",
      );
      assert.equal(hits, oldHits);
      await assert.rejects(
        sessions.content(target, undefined, "owner"),
        /Session unavailable/,
      );
      assert.equal((await sessions.shutdown()).complete, true);
    } finally {
      await sessions.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
