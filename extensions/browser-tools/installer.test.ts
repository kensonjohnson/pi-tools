import { test } from "node:test";
import assert from "node:assert/strict";
import { ChromiumInstaller, runInstallCommand } from "./installer.ts";
import { resolveBrowserSettings } from "./settings.ts";
import { mkdtemp, readFile, rm, access, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lockPath = async () =>
  join(await mkdtemp(join(tmpdir(), "browser-install-test-")), "lock.sqlite");

test("missing Chromium is trust gated and unsupported platforms do not install", async () => {
  let calls = 0;
  const path = await lockPath();
  const installer = new ChromiumInstaller({
    platform: "darwin",
    lockPath: path,
    exists: async () => false,
    run: async () => {
      calls++;
    },
  });
  assert.match(
    (
      (await installer.ensure({ trusted: false, autoInstall: true })) as {
        message: string;
      }
    ).message,
    /Trust/,
  );
  assert.match(
    (
      (await installer.ensure({ trusted: true, autoInstall: false })) as {
        message: string;
      }
    ).message,
    /missing/,
  );
  assert.equal(calls, 0);
  const unsupported = new ChromiumInstaller({
    platform: "linux",
    exists: async () => true,
  });
  assert.match(
    (
      (await unsupported.ensure({ trusted: true, autoInstall: true })) as {
        message: string;
      }
    ).message,
    /macOS/,
  );
  await rm(join(path, ".."), { recursive: true, force: true });
});

test("install waiters share one flight and cancellation does not interrupt another waiter", async () => {
  let complete!: () => void;
  let available = false;
  let calls = 0;
  let progress!: (text: string) => void;
  const gate = new Promise<void>((resolve) => {
    complete = () => {
      available = true;
      resolve();
    };
  });
  const installer = new ChromiumInstaller({
    platform: "darwin",
    lockPath: await lockPath(),
    exists: async () => available,
    run: async (_signal, notify) => {
      calls++;
      progress = notify;
      await gate;
    },
  });
  const controller = new AbortController();
  const updates: string[] = [];
  const first = installer.ensure({
    trusted: true,
    autoInstall: true,
    signal: controller.signal,
  });
  const second = installer.ensure({
    trusted: true,
    autoInstall: true,
    progress: (text) => updates.push(text),
  });
  while (!progress) await new Promise((resolve) => setTimeout(resolve, 10));
  progress("downloading");
  controller.abort();
  assert.equal((await first).ok, false);
  assert.equal(calls, 1);
  complete();
  assert.equal((await second).ok, true);
  assert.deepEqual(updates, ["downloading"]);
});

test("an existing binary with an active marker waits for the owner", async () => {
  const path = await lockPath();
  let available = false;
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const installer = new ChromiumInstaller({
    platform: "darwin",
    lockPath: path,
    exists: async () => available,
    run: async () => {
      available = true;
      started();
      await gate;
    },
  });
  const first = installer.ensure({ trusted: true, autoInstall: true });
  await ready;
  let secondSettled = false;
  const second = installer
    .ensure({ trusted: false, autoInstall: false })
    .then((result) => {
      secondSettled = true;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(secondSettled, false);
  release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
});

test(
  "availability check excludes a concurrent installer under the same lock",
  { timeout: 5000 },
  async () => {
    const path = await lockPath();
    let release!: () => void;
    let checking!: () => void;
    const startedCheck = new Promise<void>((resolve) => {
      checking = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ran = false;
    let available = false;
    const observer = new ChromiumInstaller({
      platform: "darwin",
      lockPath: path,
      exists: async () => {
        checking();
        await gate;
        return available;
      },
    });
    const owner = new ChromiumInstaller({
      platform: "darwin",
      lockPath: path,
      exists: async () => available,
      run: async () => {
        ran = true;
        available = true;
      },
    });
    const observation = observer.ensure({ trusted: false, autoInstall: false });
    try {
      await startedCheck;
      const installation = owner.ensure({ trusted: true, autoInstall: true });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(ran, false);
      // The observer's missing-binary result and marker observation are atomic
      // with respect to this installer; it cannot return a partial install.
      release();
      assert.equal((await observation).ok, false);
      assert.equal((await installation).ok, true);
      assert.equal(ran, true);
    } finally {
      release();
      await observation;
      await rm(join(path, ".."), { recursive: true, force: true });
    }
  },
);

test("verified zero exit without a matching executable retains the marker", async () => {
  const path = await lockPath();
  let runs = 0;
  const installer = new ChromiumInstaller({
    platform: "darwin",
    lockPath: path,
    exists: async () => false,
    run: async (signal, progress, recordGroup) => {
      runs++;
      await runInstallCommand(
        process.execPath,
        ["-e", "process.exit(0)"],
        signal,
        progress,
        recordGroup,
      );
    },
  });
  try {
    const result = await installer.ensure({ trusted: true, autoInstall: true });
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.match(result.message, /matching executable is missing/);
    assert.match(await readFile(`${path}.pending`, "utf8"), /group-pid/);
    for (const trusted of [false, true]) {
      const retry = await installer.ensure({ trusted, autoInstall: trusted });
      assert.equal(retry.ok, false);
      if (!retry.ok)
        assert.match(retry.message, /unresolved process ownership/);
    }
    assert.equal(runs, 1);
  } finally {
    await rm(join(path, ".."), { recursive: true, force: true });
  }
});

test("successful verified group completion removes its ownership record", async () => {
  const path = await lockPath();
  let available = false;
  const installer = new ChromiumInstaller({
    platform: "darwin",
    lockPath: path,
    exists: async () => available,
    run: async (signal, progress, recordGroup) => {
      await runInstallCommand(
        process.execPath,
        ["-e", "process.exit(0)"],
        signal,
        progress,
        recordGroup,
      );
      available = true;
    },
  });
  try {
    assert.equal(
      (await installer.ensure({ trusted: true, autoInstall: true })).ok,
      true,
    );
    await assert.rejects(access(`${path}.pending`), { code: "ENOENT" });
  } finally {
    await rm(join(path, ".."), { recursive: true, force: true });
  }
});

test("installer subprocess disables cache GC without mutating parent environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-install-env-"));
  const output = join(dir, "env");
  const before = process.env.PLAYWRIGHT_SKIP_BROWSER_GC;
  try {
    const script = `require('fs').writeFileSync(${JSON.stringify(output)},process.env.PLAYWRIGHT_SKIP_BROWSER_GC || '')`;
    await runInstallCommand(
      process.execPath,
      ["-e", script],
      new AbortController().signal,
      () => {},
    );
    assert.equal(await readFile(output, "utf8"), "1");
    assert.equal(process.env.PLAYWRIGHT_SKIP_BROWSER_GC, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("separate processes serialize and recheck the installed binary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-install-process-"));
  const helper = fileURLToPath(
    new URL("./installer-test-helper.mjs", import.meta.url),
  );
  const launch = () =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [helper, dir], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let error = "";
      child.stderr.on("data", (chunk) => {
        error += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(error)),
      );
    });
  try {
    await Promise.all([launch(), launch()]);
    assert.equal(await readFile(join(dir, "calls"), "utf8"), "run\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cross-process lock waiter can time out without cancelling its owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-install-wait-"));
  const helper = fileURLToPath(
    new URL("./installer-test-helper.mjs", import.meta.url),
  );
  const child = spawn(process.execPath, [helper, dir], { stdio: "ignore" });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  try {
    while (
      !(await access(join(dir, "calls")).then(
        () => true,
        () => false,
      ))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let ran = false;
    const installer = new ChromiumInstaller({
      platform: "darwin",
      lockPath: join(dir, "lock.sqlite"),
      exists: async () => false,
      run: async () => {
        ran = true;
      },
    });
    const outcome = await installer.ensure({
      trusted: true,
      autoInstall: true,
      timeoutMs: 50,
    });
    assert.equal(outcome.ok, false);
    assert.equal(await done, 0);
    assert.equal(ran, false);
    assert.equal(await readFile(join(dir, "calls"), "utf8"), "run\n");
  } finally {
    if (child.exitCode === null) child.kill();
    await done;
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancellation kills a SIGTERM-resistant process group including descendants", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-install-kill-"));
  const marker = join(dir, "survived");
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const descendant = `process.on('SIGTERM',()=>{}); setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'alive'),1200); setInterval(()=>{},1000)`;
  const script = `process.on('SIGTERM',()=>{}); require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}); console.log('ready'); setInterval(()=>{},1000)`;
  try {
    const running = runInstallCommand(
      process.execPath,
      ["-e", script],
      controller.signal,
      (text) => {
        if (text.includes("Installing")) started();
      },
    );
    await ready;
    controller.abort();
    await assert.rejects(
      running,
      /cancelled|termination could not be verified/,
    );
    await new Promise((resolve) => setTimeout(resolve, 1400));
    await assert.rejects(access(marker));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("abrupt owner death leaves a durable fail-closed record even if a binary appears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-install-crash-"));
  const helper = fileURLToPath(
    new URL("./installer-test-helper.mjs", import.meta.url),
  );
  const child = spawn(process.execPath, [helper, dir, "group"], {
    stdio: "ignore",
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  try {
    const deadline = Date.now() + 4000;
    let record = "";
    while (!record.includes("group-pid ")) {
      record = await readFile(join(dir, "lock.sqlite.pending"), "utf8").catch(
        () => "",
      );
      if (Date.now() >= deadline || child.exitCode !== null)
        throw new Error("owner did not record its group");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(record, new RegExp(`owner-pid ${child.pid}\\n`));
    child.kill("SIGKILL");
    await done;
    assert.equal(
      (await stat(join(dir, "lock.sqlite.pending"))).mode & 0o777,
      0o600,
    );
    let calls = 0;
    for (const binaryExists of [false, true])
      for (const trusted of [false, true]) {
        const installer = new ChromiumInstaller({
          platform: "darwin",
          lockPath: join(dir, "lock.sqlite"),
          exists: async () => binaryExists,
          run: async () => {
            calls++;
          },
        });
        const result = await installer.ensure({
          trusted,
          autoInstall: trusted,
        });
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.match(result.message, /unresolved process ownership/);
          assert.match(
            result.message,
            /Ownership record:.*lock.sqlite.pending/,
          );
          assert.match(result.message, /do not blindly signal/i);
        }
      }
    assert.equal(calls, 0);
    // The owned fixture exits on its own; never signal a recovered PID.
    await new Promise((resolve) => setTimeout(resolve, 1400));
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await done;
    await rm(dir, { recursive: true, force: true });
  }
});

test("unverified termination retains the private lock and suppresses raw output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-install-unsafe-"));
  const lock = join(dir, "lock.sqlite");
  const originalKill = process.kill;
  const updates: string[] = [];
  let calls = 0;
  // Simulate an OS that cannot confirm process-group termination.
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid < 0 && signal === 0) return true;
    return originalKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
  try {
    const installer = new ChromiumInstaller({
      platform: "darwin",
      lockPath: lock,
      exists: async () => false,
      run: async (signal, progress) => {
        calls++;
        await runInstallCommand(
          process.execPath,
          ["-e", "console.log('secret-install-url')"],
          signal,
          progress,
        );
      },
    });
    const result = await installer.ensure({
      trusted: true,
      autoInstall: true,
      progress: (text) => updates.push(text),
    });
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.match(result.message, /termination could not be verified/);
    assert.deepEqual(updates, ["Installing matching Chromium."]);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(lock)).mode & 0o777, 0o600);
    assert.match(await readFile(`${lock}.pending`, "utf8"), /owner-pid/);
    const second = await installer.ensure({
      trusted: true,
      autoInstall: true,
      timeoutMs: 100,
    });
    assert.equal(second.ok, false);
    assert.equal(calls, 1);
  } finally {
    process.kill = originalKill;
    await rm(dir, { recursive: true, force: true });
  }
});

test("offline errors are bounded and settings reject invalid values", async () => {
  const installer = new ChromiumInstaller({
    platform: "darwin",
    lockPath: await lockPath(),
    exists: async () => false,
    run: async () => {
      throw new Error("offline");
    },
  });
  const outcome = await installer.ensure({ trusted: true, autoInstall: true });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.message, /offline/);
  const settings = resolveBrowserSettings({
    enabled: false,
    startupTimeoutMs: -1,
    autoInstall: false,
  });
  assert.equal(settings.enabled, false);
  assert.equal(settings.autoInstall, false);
  assert.equal(settings.startupTimeoutMs, 180000);
});
