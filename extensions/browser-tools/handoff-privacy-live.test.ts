import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { BrowserDiagnostics } from "./diagnostics.ts";
import { ManagedSessions } from "./sessions.ts";

test(
  "headed handoff does not retain OAuth console output and reports a diagnostic gap",
  {
    skip:
      process.env.BROWSER_HEADED !== "1" ||
      !existsSync(chromium.executablePath()),
    timeout: 30000,
  },
  async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(
        `<title>login</title><script>console.log('human-mfa-secret')</script>`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    let browser!: Browser;
    const diagnostics = new BrowserDiagnostics();
    const sessions = new ManagedSessions({
      launch: async ({ headless }) => {
        browser = await chromium.launch({ headless });
        return browser;
      },
      diagnostics,
    });
    try {
      const target = await sessions.start({
        headless: false,
        artifactOwner: "owner",
      });
      const before = await sessions.beginHandoff(target, "owner");
      assert.equal(before.status, "awaiting_human");
      const page = browser.contexts()[0].pages()[0];
      await page.goto(
        `http://127.0.0.1:${(server.address() as any).port}/callback?code=oauth-private`,
      );
      assert.doesNotMatch(
        JSON.stringify(sessions.list("owner")),
        /oauth-private|callback/,
      );
      sessions.confirmHandoff(target.sessionId, before.handoffId!, "owner");
      const after = diagnostics.read(target);
      assert.doesNotMatch(
        JSON.stringify(after),
        /human-mfa-secret|oauth-private/,
      );
      assert.match(JSON.stringify(after.gaps), /before attachment/);
      assert.doesNotMatch(
        JSON.stringify(sessions.list("owner")),
        /oauth-private/,
      );
      await page.evaluate(() => console.log("ordinary-after-confirmation"));
      assert.match(
        JSON.stringify(diagnostics.read(target)),
        /ordinary-after-confirmation/,
      );
    } finally {
      await sessions.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
