import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ManagedSessions } from "../../extensions/browser-tools/sessions.ts";
import { ArtifactStore } from "../../extensions/browser-tools/artifacts.ts";
import { createManagedBrowserExtension } from "../../extensions/browser-tools/registration.ts";

test("registered extraction enforces owner, serialized access, provenance and private artifacts", async () => {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/redirect")) {
      res.writeHead(302, { location: "/landing?token=finalsecret" });
      res.end();
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url?.startsWith("/child"))
      res.end(
        '<title>Child</title><main><h1>Frame text</h1><a href="/next?token=linksecret">next</a></main>',
      );
    else if (req.url === "/favicon.ico") {
      res.writeHead(204);
      res.end();
    } else
      res.end(
        `<title>Parent</title><div id="small">small</div><p>${"é🙂".repeat(12000)}</p><iframe id="visible" src="http://localhost:${(server.address() as any).port}/child?token=framesecret"></iframe><iframe id="hidden" hidden srcdoc="&lt;p&gt;private hidden frame&lt;/p&gt;"></iframe>`,
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "extract-registration-")),
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
    on(name: string, fn: Function) {
      handlers.set(name, fn);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
      active.push(tool.name);
    },
    getActiveTools: () => active,
    setActiveTools(value: string[]) {
      active = value;
    },
  };
  let sessions!: ManagedSessions;
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createInstaller: () => ({ ensure: async () => ({ ok: true }) }) as never,
    createArtifacts: () => new ArtifactStore({ root: join(root, "artifacts") }),
    createSessions: (diagnostics, downloads) =>
      (sessions = new ManagedSessions({
        launch: ({ headless }) =>
          chromium.launch({
            headless,
            channel: "chromium",
            args: [
              "--site-per-process",
              "--host-resolver-rules=MAP localhost 127.0.0.1",
            ],
          }),
        diagnostics,
        downloads,
      })),
  });
  const context = (owner: string) => ({
    cwd: root,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => owner },
  });
  const call = async (
    owner: string,
    name: string,
    args: any,
    signal?: AbortSignal,
  ) =>
    JSON.parse(
      (
        await tools
          .get(name)
          .execute("id", args, signal, undefined, context(owner))
      ).content[0].text,
    );
  try {
    await handlers.get("session_start")!({}, context("alice"));
    assert(active.includes("browser_extract"));
    const target = await call("alice", "browser_session", {
      action: "start",
      headless: true,
      purpose: "research",
    });
    await call("alice", "browser_navigate", {
      ...target,
      url: `http://127.0.0.1:${port}/?token=pagesecret`,
    });
    await assert.rejects(call("bob", "browser_extract", target), /unavailable/);
    await assert.rejects(call("bob", "browser_extract", {}), /unavailable/);
    const frame = JSON.parse(
      (
        await call("alice", "browser_extract", {
          ...target,
          frameSelector: "#visible",
        })
      ).text,
    );
    assert.equal(frame.requestedUrl, null);
    assert.match(frame.text, /Frame text/);
    assert.doesNotMatch(JSON.stringify(frame), /framesecret|linksecret/);
    assert.match(frame.finalUrl, /redacted/);
    assert.match(frame.links[0].url, /redacted/);
    await assert.rejects(
      call("alice", "browser_extract", { ...target, frameSelector: "#hidden" }),
      /frame is hidden/,
    );
    const result = await call("alice", "browser_extract", target);
    assert.equal(result.complete, false);
    assert.ok(result.artifact.id);
    assert.doesNotMatch(JSON.stringify(result), /pagesecret/);
    await assert.rejects(
      call("bob", "browser_artifact", {
        action: "read",
        id: result.artifact.id,
      }),
      /owned by another/,
    );
    let offset = 0,
      content = "";
    for (;;) {
      const chunk = await call("alice", "browser_artifact", {
        action: "read",
        id: result.artifact.id,
        offset,
      });
      content += chunk.text;
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    }
    const record = JSON.parse(content);
    assert.match(record.requestedUrl, /redacted/);
    assert.match(record.finalUrl, /redacted/);
    assert.match(record.text, /é🙂/);
    const readSmall = async () =>
      JSON.parse(
        (
          await call("alice", "browser_extract", {
            ...target,
            selector: "#small",
          })
        ).text,
      );
    await call("alice", "browser_navigate", {
      ...target,
      url: `http://127.0.0.1:${port}/redirect?token=requestsecret`,
    });
    const redirected = await readSmall();
    assert.match(redirected.requestedUrl, /\/redirect\?token=/);
    assert.match(redirected.finalUrl, /\/landing\?token=/);
    assert.doesNotMatch(
      JSON.stringify(redirected),
      /requestsecret|finalsecret/,
    );
    await call("alice", "browser_eval", {
      ...target,
      code: 'history.pushState({}, "", location.href)',
    });
    assert.equal((await readSmall()).requestedUrl, null);
    await call("alice", "browser_navigate", {
      ...target,
      url: `http://127.0.0.1:${port}/redirect`,
    });
    await call("alice", "browser_eval", {
      ...target,
      code: 'history.replaceState({}, "", location.href)',
    });
    assert.equal((await readSmall()).requestedUrl, null);
    await call("alice", "browser_navigate", {
      ...target,
      url: `http://127.0.0.1:${port}/redirect`,
    });
    await sessions.withOwnedPage(target, undefined, "alice", async (page) => {
      await page.reload();
    });
    assert.equal((await readSmall()).requestedUrl, null);
    await call("alice", "browser_navigate", {
      ...target,
      url: `http://127.0.0.1:${port}/redirect`,
    });
    assert.match((await readSmall()).requestedUrl, /\/redirect/);
    await sessions.withOwnedPage(target, undefined, "alice", async (page) => {
      await page.goto(`http://127.0.0.1:${port}/external`);
    });
    const external = await readSmall();
    assert.equal(external.requestedUrl, null);
    assert.match(external.finalUrl, /\/external/);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = sessions.withOwnedPage(
      target,
      undefined,
      "alice",
      async () => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    );
    await entered;
    await assert.rejects(call("alice", "browser_extract", target), /busy/);
    release();
    await held;
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      call("alice", "browser_extract", target, cancelled.signal),
      /cancelled/,
    );
    assert.match(
      JSON.parse(
        (
          await call("alice", "browser_extract", {
            ...target,
            frameSelector: "#visible",
          })
        ).text,
      ).text,
      /Frame text/,
    );
    let releaseCdp!: () => void;
    let extractionDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      extractionDispatched = resolve;
    });
    await sessions.withOwnedPage(target, undefined, "alice", async (page) => {
      const browserContext = page.context();
      const original = browserContext.newCDPSession.bind(browserContext);
      browserContext.newCDPSession = async (target) => {
        extractionDispatched();
        await new Promise<void>((resolve) => {
          releaseCdp = resolve;
        });
        return original(target);
      };
    });
    const abort = new AbortController();
    const pending = call("alice", "browser_extract", target, abort.signal);
    await dispatched;
    abort.abort();
    await assert.rejects(pending, /cancelled/);
    releaseCdp();
    await assert.rejects(
      call("alice", "browser_extract", target),
      /unavailable/,
    );
  } finally {
    await handlers.get("session_shutdown")!();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
  assert(!active.includes("browser_extract"));
});
