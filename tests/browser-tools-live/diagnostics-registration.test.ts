import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium, type Browser } from "playwright";
import { ManagedSessions } from "../../extensions/browser-tools/sessions.ts";
import { createManagedBrowserExtension } from "../../extensions/browser-tools/registration.ts";

test("staged registration captures only owned pages and redacts multiple cookies", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": ["sid=firstsecret; HttpOnly", "other=secondsecret; Secure"],
    });
    res.end(`<script>console.warn('initial fixture')</script>${req.url}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const handlers = new Map<string, Function>(),
    tools = new Map<string, any>();
  let active: string[] = [];
  let browser: Browser | undefined;
  const pi = {
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    on(name: string, fn: Function) {
      handlers.set(name, fn);
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
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createInstaller: () => ({ ensure: async () => ({ ok: true }) }) as never,
    createSessions: (diagnostics) =>
      new ManagedSessions({
        launch: async ({ headless }) =>
          (browser = await chromium.launch({ headless, channel: "chromium" })),
        diagnostics,
      }),
  });
  const call = async (name: string, args: any) =>
    JSON.parse((await tools.get(name).execute("id", args)).content[0].text);
  try {
    await handlers.get("session_start")!(
      {},
      { cwd: "/tmp", isProjectTrusted: () => true },
    );
    const target = await call("browser_session", {
      action: "start",
      headless: true,
    });
    await call("browser_navigate", {
      ...target,
      url: `http://127.0.0.1:${address.port}/owned?token=hidden`,
    });
    const unrelated = await browser!.contexts()[0].newPage();
    await unrelated.goto(`http://127.0.0.1:${address.port}/unowned`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const history = await call("browser_diagnostics", {
      ...target,
      action: "read",
    });
    const rendered = JSON.stringify(history);
    assert(history.logs.some((x: any) => x.text === "initial fixture"));
    assert(!rendered.includes("unowned"));
    assert(!rendered.includes("firstsecret"));
    assert(!rendered.includes("secondsecret"));
    assert(!rendered.includes("token=hidden"));
    const req = history.requests.find((x: any) => x.url.includes("/owned"));
    assert(req);
    const revealed = await call("browser_diagnostic_headers", {
      ...target,
      requestId: req.id,
      direction: "response",
      names: ["set-cookie"],
    });
    assert.match(revealed.values["set-cookie"], /firstsecret/);
    assert.match(revealed.values["set-cookie"], /secondsecret/);
    await assert.rejects(
      call("browser_diagnostics", {
        sessionId: target.sessionId,
        tabId: "unowned",
        action: "read",
      }),
      /unavailable/,
    );
    await call("browser_session", {
      action: "stop",
      sessionId: target.sessionId,
    });
    await assert.rejects(
      call("browser_diagnostics", { ...target, action: "read" }),
      /unavailable/,
    );
  } finally {
    await handlers.get("session_shutdown")!();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
