import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { chromium, type Browser } from "playwright";
import { ManagedSessions } from "../../extensions/browser-tools/sessions.ts";

test(
  "abort and shutdown close owned browsers during a slow local navigation",
  { timeout: 30_000 },
  async () => {
    const pending: ServerResponse[] = [];
    const server = createServer((_req, res) => {
      pending.push(res);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const browsers: Browser[] = [];
    const makeRuntime = () =>
      new ManagedSessions({
        launch: async ({ headless }) => {
          const browser = await chromium.launch({
            headless,
            channel: "chromium",
          });
          browsers.push(browser);
          return browser;
        },
      });
    const runtimes: ManagedSessions[] = [];
    const headless = process.env.BROWSER_HEADED !== "1";
    try {
      for (const mode of ["abort", "shutdown"] as const) {
        const runtime = makeRuntime();
        runtimes.push(runtime);
        const target = await runtime.start({ headless });
        const browser = browsers.at(-1)!;
        const request = once(server, "request");
        const controller = new AbortController();
        const navigation = runtime.navigate(
          `http://127.0.0.1:${address.port}/slow`,
          target,
          controller.signal,
        );
        const outcome = navigation.then(
          () => ({ success: true as const }),
          (error) => ({ success: false as const, error }),
        );
        await request;
        if (mode === "abort") controller.abort();
        else await runtime.shutdown();
        const actual = await outcome;
        assert.equal(
          actual.success,
          false,
          `${mode} must not return navigation success`,
        );
        if (!actual.success && mode === "abort")
          assert.match(String(actual.error), /cancelled.*already dispatched/s);
        assert.equal((await runtime.shutdown()).complete, true);
        assert.equal(
          browser.isConnected(),
          false,
          `${mode} must close the owned browser`,
        );
        for (const response of pending.splice(0)) response.end("late response");
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal((await outcome).success, false);
      }
    } finally {
      for (const response of pending) response.destroy();
      await Promise.all(runtimes.map((runtime) => runtime.shutdown()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
