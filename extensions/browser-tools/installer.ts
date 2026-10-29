import { access, chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import {
  appendFileSync,
  closeSync,
  constants,
  fsyncSync,
  openSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { chromium } from "playwright";

export type InstallOutcome = { ok: true } | { ok: false; message: string };
export type InstallRunner = (
  signal: AbortSignal,
  progress: (text: string) => void,
  recordGroup?: (pid: number) => void,
) => Promise<void>;

type Flight = {
  controller: AbortController;
  promise: Promise<void>;
  waiters: Set<(text: string) => void>;
};
let shared: Flight | undefined;
// Keep the OS lock alive if we cannot prove that an installer group stopped.
const quarantinedLocks: Database.Database[] = [];
class UnsafeCleanupError extends Error {}

const cancelled = () => new Error("Installation cancelled.");
const recovery = (path: string) =>
  `Ownership record: ${markerPath(path)}. Inspect the owner and recorded process group, independently verify all installer processes have stopped, then remove the record manually before retrying. PIDs can be reused; do not blindly signal them. This covers the pinned CLI's ordinary process group, not deliberately detached descendants.`;
const unresolved = (path: string) =>
  new Error(
    `A previous Chromium installation has unresolved process ownership; automatic installation is blocked. ${recovery(path)}`,
  );
const markerPath = (lockPath: string) => `${lockPath}.pending`;
async function markerExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function createMarker(path: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(
      `browser-tools installer ownership v1\nowner-pid ${process.pid}\ngroup unknown\n`,
    );
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
}
function recordGroup(path: string, pid: number): void {
  const fd = openSync(path, "a");
  try {
    appendFileSync(fd, `group-pid ${pid}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
async function removeMarker(path: string): Promise<void> {
  await unlink(path);
  await syncDirectory(dirname(path));
}
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal.addEventListener("abort", abort, { once: true });
  });

/** The transaction is held for the entire install and is released by the OS on process death. */
async function coordinatedInstall(
  lockPath: string,
  exists: () => Promise<boolean>,
  run: InstallRunner,
  signal: AbortSignal,
  progress: (text: string) => void,
  allowInstall = true,
): Promise<void> {
  const lockDir = dirname(lockPath);
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(lockDir);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.())
    throw new Error(
      "Installer lock directory is not a private owned directory.",
    );
  await chmod(lockDir, 0o700);
  try {
    const file = await lstat(lockPath);
    if (!file.isFile() || file.uid !== process.getuid?.())
      throw new Error("Installer lock file is not an owned regular file.");
    await chmod(lockPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (signal.aborted) throw cancelled();
  const db = new Database(lockPath, { timeout: 0 });
  let locked = false;
  let quarantine = false;
  try {
    while (!locked) {
      if (signal.aborted) throw cancelled();
      try {
        db.exec("BEGIN IMMEDIATE");
        locked = true;
      } catch (error) {
        if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
        await delay(100, signal);
      }
    }
    if (signal.aborted) throw cancelled();
    // Another process may have completed the matching install while we waited.
    await chmod(lockPath, 0o600);
    const marker = markerPath(lockPath);
    if (await markerExists(marker)) throw unresolved(lockPath);
    if (!(await exists())) {
      if (!allowInstall)
        throw new Error(
          "Matching Chromium is missing. Trust the project and enable automatic installation, or run the pinned Playwright CLI install chromium manually.",
        );
      // Persist ownership before spawning; a crash at any later point fails closed.
      await createMarker(marker);
      if (signal.aborted) throw cancelled();
      // Any interrupted or failed attempt remains recoverable, even if group cleanup succeeded.
      await run(signal, progress, (pid) => recordGroup(marker, pid));
      if (signal.aborted) throw cancelled();
      if (!(await exists()))
        throw new Error(
          "Chromium installation finished but the matching executable is missing.",
        );
      if (signal.aborted) throw cancelled();
      await removeMarker(marker);
    }
  } catch (error) {
    if (locked && error instanceof UnsafeCleanupError) quarantine = true;
    throw error;
  } finally {
    if (quarantine) quarantinedLocks.push(db);
    else {
      if (locked) db.exec("ROLLBACK");
      db.close();
    }
  }
}

/** Run a command in its own process group and bound cleanup on cancellation or exit. */
export function runInstallCommand(
  command: string,
  args: string[],
  signal: AbortSignal,
  progress: (text: string) => void,
  onSpawn?: (pid: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: "1" },
    });
    let settled = false;
    let cleaning = false;
    let exited = false;
    let result: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reportedProgress = false;
    const output = () => {
      if (reportedProgress) return;
      reportedProgress = true;
      try {
        progress("Installing matching Chromium.");
      } catch {}
    };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) reject(error);
      else resolve();
    };
    const unsafe = () =>
      finish(
        new UnsafeCleanupError(
          "Installer process group termination could not be verified; installation lock retained until process exit.",
        ),
      );
    const send = (sig: NodeJS.Signals): boolean => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, sig);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    const verify = (until: number) => {
      if (settled) return;
      try {
        if (!send(0 as unknown as NodeJS.Signals) && exited)
          return finish(result);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") return unsafe();
      }
      if (Date.now() >= until) return unsafe();
      timer = setTimeout(() => verify(until), 25);
    };
    const killAndVerify = () => {
      try {
        send("SIGKILL");
      } catch {
        return unsafe();
      }
      verify(Date.now() + 1000);
    };
    const abort = () => {
      if (cleaning) {
        result = cancelled();
        return;
      }
      cleaning = true;
      result = cancelled();
      try {
        send("SIGTERM");
      } catch {
        return unsafe();
      }
      timer = setTimeout(killAndVerify, 250);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.once("error", (error) => {
      // A failed spawn has no process group. Any later process error is unsafe.
      if (!child.pid) finish(error);
      else unsafe();
    });
    child.once("exit", (code) => {
      exited = true;
      if (cleaning) return;
      cleaning = true;
      if (signal.aborted) result = cancelled();
      else if (code !== 0)
        result = new Error(`Playwright install failed (${code ?? "signal"}).`);
      killAndVerify();
    });
    if (child.pid && onSpawn) {
      try {
        onSpawn(child.pid);
      } catch {
        abort();
        result = new Error("Could not persist installer process ownership.");
      }
    }
  });
}

/** Run only the pinned package's CLI, without a shell or global environment mutation. */
export const runPlaywrightInstall: InstallRunner = (
  signal,
  progress,
  recordGroup,
) => {
  const require = createRequire(import.meta.url);
  const cli = join(
    dirname(require.resolve("playwright/package.json")),
    "cli.js",
  );
  return runInstallCommand(
    process.execPath,
    [cli, "install", "--no-shell", "chromium"],
    signal,
    progress,
    recordGroup,
  );
};

/** One process-wide install flight. Individual waiters can cancel independently. */
export class ChromiumInstaller {
  private readonly options: {
    exists?: () => Promise<boolean>;
    run?: InstallRunner;
    platform?: string;
    lockPath?: string;
  };
  constructor(options: ChromiumInstaller["options"] = {}) {
    this.options = options;
  }

  async ensure(options: {
    trusted: boolean;
    autoInstall: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    progress?: (text: string) => void;
  }): Promise<InstallOutcome> {
    if ((this.options.platform ?? process.platform) !== "darwin")
      return {
        ok: false,
        message: "Managed Chromium currently supports macOS only.",
      };
    if (options.signal?.aborted)
      return { ok: false, message: "Chromium setup cancelled." };
    const exists =
      this.options.exists ??
      (async () => {
        try {
          await access(chromium.executablePath(), constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    const lockPath =
      this.options.lockPath ??
      join(
        homedir(),
        ".cache",
        "browser-tools",
        "installer",
        "chromium-install.sqlite",
      );
    // Availability and the ownership marker must be observed under the same lock,
    // including for callers that are not permitted to install.
    if (!options.trusted || !options.autoInstall) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort!: () => void;
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => {
          controller.abort();
          reject(new Error("Chromium setup cancelled."));
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Chromium setup deadline exceeded."));
        }, options.timeoutMs ?? 180_000);
      });
      try {
        if (options.signal?.aborted) abort();
        await Promise.race([
          coordinatedInstall(
            lockPath,
            exists,
            async () => {},
            controller.signal,
            () => {},
            false,
          ),
          interrupted,
        ]);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          message: `Chromium setup failed: ${String(error).slice(0, 2048)}. ${recovery(lockPath)}`,
        };
      } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        controller.abort();
      }
    }
    if (!shared || shared.controller.signal.aborted) {
      const controller = new AbortController();
      const flight: Flight = {
        controller,
        waiters: new Set(),
        promise: Promise.resolve(),
      };
      shared = flight;
      flight.promise = Promise.resolve()
        .then(() =>
          coordinatedInstall(
            lockPath,
            exists,
            this.options.run ?? runPlaywrightInstall,
            controller.signal,
            (text) => {
              for (const notify of flight.waiters) {
                try {
                  notify(text);
                } catch {}
              }
            },
          ),
        )
        .finally(() => {
          if (shared === flight) shared = undefined;
        });
      void flight.promise.catch(() => {});
    }
    const flight = shared;
    const subscriber = (text: string) => options.progress?.(text);
    flight.waiters.add(subscriber);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Chromium setup cancelled."));
      options.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => reject(new Error("Chromium setup deadline exceeded.")),
        options.timeoutMs ?? 180_000,
      );
    });
    try {
      if (options.signal?.aborted) abort();
      await Promise.race([flight.promise, interrupted]);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: `Chromium setup failed: ${String(error).slice(0, 2048)}. An interrupted or failed install may retain an ownership record. ${recovery(lockPath)}`,
      };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      flight.waiters.delete(subscriber);
      if (!flight.waiters.size) flight.controller.abort();
    }
  }
}
