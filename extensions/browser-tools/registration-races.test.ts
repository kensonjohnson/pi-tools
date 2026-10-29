import { test } from "node:test";
import assert from "node:assert/strict";
import { createManagedBrowserExtension } from "./registration.ts";
import { ManagedSessions } from "./sessions.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function piFixture() {
  const handlers = new Map<string, Function>(),
    tools = new Map<string, any>();
  let active = ["read"];
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
    getActiveTools() {
      return active;
    },
    setActiveTools(names: string[]) {
      active = names;
    },
  };
  return { pi, handlers, tools, active: () => active };
}
const ctx = { cwd: "/tmp", isProjectTrusted: () => true };

test("registered session list emits valid bounded JSON with omission counts", async () => {
  const f = piFixture();
  const tabs = Array.from({ length: 200 }, (_, i) => ({
    tabId: `tab-${i}`,
    url: "https://example.test/" + "😀".repeat(1000),
  }));
  createManagedBrowserExtension(f.pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createSessions: () =>
      ({
        list: () => [
          {
            sessionId: "session",
            purpose: "development",
            headless: true,
            tabs,
          },
        ],
        shutdown: async () => ({ complete: true }),
      }) as never,
    createInstaller: () => ({}) as never,
  });
  await f.handlers.get("session_start")!({}, ctx);
  const result = await f.tools
    .get("browser_session")
    .execute("x", { action: "list" });
  const text = result.content[0].text;
  assert.ok(Buffer.byteLength(text) <= 16000);
  const parsed = JSON.parse(text);
  assert.equal(
    parsed.sessions[0].tabs.length + parsed.omittedTabs,
    tabs.length,
  );
  assert.ok(parsed.omittedTabs > 0 || parsed.omittedUrls > 0);
  await f.handlers.get("session_shutdown")!({}, ctx);
});

test("diagnostic shutdown faults still close the owned runtime and report uncertainty", async () => {
  const f = piFixture();
  let closed = 0;
  const warnings: string[] = [];
  const prior = console.warn;
  createManagedBrowserExtension(f.pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createSessions: (diagnostics) => {
      diagnostics!.shutdown = () => {
        throw new Error("injected diagnostics cleanup fault");
      };
      return {
        shutdown: async () => {
          closed++;
          return { complete: true };
        },
      } as never;
    },
    createInstaller: () => ({}) as never,
  });
  try {
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    await f.handlers.get("session_start")!({}, ctx);
    await f.handlers.get("session_shutdown")!({}, ctx);
    assert.equal(closed, 1);
    assert.match(warnings.join(" "), /could not be verified/);
  } finally {
    console.warn = prior;
  }
});

test("unsupported host and launch failure produce actionable tool errors", async () => {
  for (const failure of ["unsupported", "launch"] as const) {
    const f = piFixture();
    createManagedBrowserExtension(f.pi as never, {
      loadSettings: async () => ({ values: {} }) as never,
      createSessions: () =>
        new ManagedSessions({
          launch: async () => {
            throw new Error("executable unavailable");
          },
        }),
      createInstaller: () =>
        ({
          ensure: async () =>
            failure === "unsupported"
              ? {
                  ok: false,
                  message: "Managed Chromium currently supports macOS only.",
                }
              : { ok: true },
        }) as never,
    });
    await f.handlers.get("session_start")!({}, ctx);
    const start = f.tools
      .get("browser_session")
      .execute("x", { action: "start" });
    await assert.rejects(
      start,
      failure === "unsupported"
        ? /Use a supported macOS host/
        : /failed to launch.*matching browser installation.*cleanup could not be verified/s,
    );
    await f.handlers.get("session_shutdown")!({}, ctx);
  }
});

test("shutdown during settings load prevents late runtime activation", async () => {
  const f = piFixture();
  const gate = deferred<any>();
  let created = 0;
  createManagedBrowserExtension(f.pi as never, {
    loadSettings: () => gate.promise,
    createSessions: () => {
      created++;
      throw new Error("must not create");
    },
  });
  const starting = f.handlers.get("session_start")!({}, ctx);
  await new Promise((r) => setImmediate(r));
  await f.handlers.get("session_shutdown")!({}, ctx);
  gate.resolve({ values: {} });
  await starting;
  assert.equal(created, 0);
  assert.deepEqual(f.active(), ["read"]);
});

test("overlapping shutdown handlers await the same cleanup", async () => {
  const f = piFixture();
  const gate = deferred<{ complete: boolean }>();
  let cleanupCalls = 0;
  createManagedBrowserExtension(f.pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createSessions: () =>
      ({
        shutdown: () => {
          cleanupCalls++;
          return gate.promise;
        },
      }) as never,
    createInstaller: () => ({}) as never,
  });
  await f.handlers.get("session_start")!({}, ctx);
  const one = f.handlers.get("session_shutdown")!({}, ctx);
  let secondFinished = false;
  const two = f.handlers.get("session_shutdown")!({}, ctx).then(() => {
    secondFinished = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(secondFinished, false);
  assert.equal(cleanupCalls, 1);
  gate.resolve({ complete: true });
  await Promise.all([one, two]);
  assert.deepEqual(f.active(), ["read"]);
});

test("shutdown cancels pending installation and prevents late launch", async () => {
  const f = piFixture();
  const gate = deferred<{ ok: true }>();
  let installSignal: AbortSignal | undefined;
  let launched = false;
  createManagedBrowserExtension(f.pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createSessions: () =>
      ({
        shutdown: async () => ({ complete: true }),
        start: async ({ signal }: { signal: AbortSignal }) => {
          if (signal.aborted) throw new Error("cancelled");
          launched = true;
        },
      }) as never,
    createInstaller: () =>
      ({
        ensure: ({ signal }: { signal: AbortSignal }) => {
          installSignal = signal;
          return gate.promise;
        },
      }) as never,
  });
  await f.handlers.get("session_start")!({}, ctx);
  const starting = f.tools
    .get("browser_session")
    .execute("x", { action: "start" });
  await f.handlers.get("session_shutdown")!({}, ctx);
  assert.equal(installSignal?.aborted, true);
  gate.resolve({ ok: true });
  await assert.rejects(starting, /cancelled/);
  assert.equal(launched, false);
});
