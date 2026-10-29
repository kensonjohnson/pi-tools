import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, mkdir, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { fork } from "node:child_process";
import { acquireProfile } from "../../extensions/browser-tools/profiles.ts";
import { ManagedSessions } from "../../extensions/browser-tools/sessions.ts";

test("a symlinked Chromium Default directory is rejected before launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-profile-link-"));
  const outside = await mkdtemp(join(tmpdir(), "browser-profile-outside-"));
  try {
    await mkdir(join(root, "profile-demo"));
    await symlink(outside, join(root, "profile-demo", "Default"));
    let launched = false;
    const runtime = new ManagedSessions({
      profileRoot: root,
      launch: ({ headless }) =>
        chromium.launch({ headless, channel: "chromium" }),
      launchPersistent: (path, { headless }) => {
        launched = true;
        return chromium.launchPersistentContext(path, {
          headless,
          channel: "chromium",
        });
      },
    });
    await assert.rejects(
      runtime.start({ profile: "demo", headless: true }),
      /Unsafe profile entry/,
    );
    assert.equal(launched, false);
    assert.deepEqual(await readdir(outside), []);
    await runtime.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a live browser and crashed lease owner leave the profile blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-profile-orphan-"));
  const child = fork(
    new URL(
      "../../extensions/browser-tools/profile-test-helper.mjs",
      import.meta.url,
    ),
    [root],
    {
      execArgv: ["--experimental-strip-types"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  let context:
    Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    await once(child, "message");
    context = await chromium.launchPersistentContext(
      join(root, "profile-shared"),
      { headless: true, channel: "chromium" },
    );
    child.kill("SIGKILL");
    await once(child, "exit");
    assert.equal(context.pages()[0].isClosed(), false);
    await assert.rejects(
      acquireProfile("shared", { root }),
      /ownership is unresolved/,
    );
    await context.close();
    context = undefined;
    await assert.rejects(
      acquireProfile("shared", { root }),
      /ownership is unresolved/,
    );
  } finally {
    await context?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("named profiles persist a local cookie, isolate other names, and serialize factories", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-profile-live-"));
  let cookie = "";
  let slowRequest!: () => void;
  const slowReady = new Promise<void>((resolve) => {
    slowRequest = resolve;
  });
  const server = createServer((req, res) => {
    if (req.url === "/slow") {
      slowRequest();
      setTimeout(() => res.end("slow"), 300);
      return;
    }
    if (req.url === "/set")
      res.setHeader("Set-Cookie", "fixture=logged-in; Path=/; Max-Age=3600");
    if (req.url === "/check") cookie = req.headers.cookie ?? "";
    res.end("local fixture");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const make = () =>
    new ManagedSessions({
      profileRoot: root,
      profileWaitMs: 10000,
      launch: ({ headless }) =>
        chromium.launch({ headless, channel: "chromium" }),
      launchPersistent: (path, { headless }) =>
        chromium.launchPersistentContext(path, {
          headless,
          channel: "chromium",
        }),
    });
  const a = make(),
    b = make();
  try {
    const headless = process.env.BROWSER_HEADED !== "1";
    await a.start({ profile: "one", headless });
    await a.navigate(`${url}/set`);
    let acquired = false;
    const waiting = b.start({ profile: "one", headless }).then((value) => {
      acquired = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(acquired, false);
    await a.stop();
    await waiting;
    cookie = "";
    await b.navigate(`${url}/check`);
    assert.match(cookie, /fixture=logged-in/);
    const controller = new AbortController();
    const slow = b.navigate(`${url}/slow`, undefined, controller.signal);
    await slowReady;
    controller.abort();
    await assert.rejects(slow, /cancelled/);
    await a.start({ profile: "one", headless });
    cookie = "";
    await a.navigate(`${url}/check`);
    assert.match(cookie, /fixture=logged-in/);
    await a.stop();
    await a.start({ profile: "two", headless });
    cookie = "";
    await a.navigate(`${url}/check`);
    assert.doesNotMatch(cookie, /fixture=logged-in/);
    await a.stop();
  } finally {
    await Promise.all([a.shutdown(), b.shutdown()]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
