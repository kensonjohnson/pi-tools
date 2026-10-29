import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const helper = fileURLToPath(
  new URL(
    "../../extensions/browser-tools/installer-test-helper.mjs",
    import.meta.url,
  ),
);

async function bounded<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

for (const mode of ["cancel", "failure"] as const) {
  test(
    `pinned Playwright CLI ${mode} retains ownership after ordinary group cleanup`,
    { timeout: 25000 },
    async () => {
      assert.equal(require("playwright/package.json").version, "1.64.1");
      const dir = await mkdtemp(join(tmpdir(), "playwright-cli-test-"));
      let requested!: () => void;
      const request = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const server = createServer((_req, res) => {
        requested();
        if (mode === "failure") {
          res.writeHead(404);
          res.end("fixture failure");
        } else {
          res.writeHead(200, { "content-length": "10000000" });
          res.write("fixture");
        }
      });
      let child: ChildProcess | undefined;
      let done:
        | Promise<{ code: number | null; signal: NodeJS.Signals | null }>
        | undefined;
      let groupPid: number | undefined;
      let groupVerifiedGone = false;
      let stderr = "";
      try {
        await bounded(
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          }),
          3000,
          "server listen",
        );
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        child = spawn(process.execPath, [helper, dir, "actual"], {
          env: {
            ...process.env,
            PLAYWRIGHT_BROWSERS_PATH: join(dir, "cache"),
            PLAYWRIGHT_DOWNLOAD_HOST: `http://127.0.0.1:${address.port}`,
            PLAYWRIGHT_SKIP_BROWSER_GC: "1",
            PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: "1000",
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        child.stderr!.on("data", (data) => {
          stderr += data;
        });
        done = new Promise((resolve, reject) => {
          child!.once("error", reject);
          child!.once("exit", (code, signal) => resolve({ code, signal }));
        });
        const earlyExit = done.then((outcome) => {
          throw new Error(
            `helper exited before fixture ready: ${JSON.stringify(outcome)} ${stderr}`,
          );
        });
        const group = new Promise<number>((resolve) =>
          child!.on("message", (message: any) => {
            if (message?.group) {
              groupPid = message.group;
              resolve(message.group);
            }
          }),
        );
        const pid = await bounded(
          Promise.race([group, earlyExit]),
          5000,
          "group start",
        );
        await bounded(
          Promise.race([request, earlyExit]),
          5000,
          "download request",
        );
        if (mode === "cancel") {
          const ps = execFileSync(
            "ps",
            ["-ax", "-o", "pid=,ppid=,pgid=,command="],
            { encoding: "utf8", timeout: 2000 },
          );
          const lines = ps
            .split("\n")
            .filter((line) => Number(line.trim().split(/\s+/)[2]) === pid);
          assert.ok(
            lines.some((line) => line.includes("cli.js")),
            lines.join("\n"),
          );
          assert.ok(
            lines.some((line) => /oopBrowserDownload/.test(line)),
            lines.join("\n"),
          );
          child.send!("cancel", () => {});
        }
        const outcome = await bounded(done, 7000, "helper exit");
        assert.equal(outcome.code, 1, stderr);
        assert.match(
          stderr,
          mode === "failure" ? /install failed/ : /cancelled/,
        );
        assert.match(stderr, /Ownership record:/);
        const marker = await readFile(join(dir, "lock.sqlite.pending"), "utf8");
        assert.match(marker, new RegExp(`group-pid ${pid}\\n`));
        assert.throws(
          () => process.kill(-pid, 0),
          (error: any) => error.code === "ESRCH",
        );
        groupVerifiedGone = true;
      } finally {
        // Request cancellation over the original IPC channel. Never signal a
        // recovered PID or process group: either may have been reused.
        if (
          child?.connected &&
          child.exitCode === null &&
          child.signalCode === null
        )
          child.send?.("cancel", () => {});
        let helperSettled = !child;
        if (done) {
          helperSettled = await bounded(
            done.then(
              () => true,
              () => true,
            ),
            6500,
            "helper cleanup",
          ).catch(() => false);
        }
        let markerUnreadable = false;
        const marker = await readFile(
          join(dir, "lock.sqlite.pending"),
          "utf8",
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") markerUnreadable = true;
          return "";
        });
        if (
          !groupPid &&
          child?.pid &&
          marker.includes(`owner-pid ${child.pid}\n`)
        ) {
          const match = marker.match(/^group-pid (\d+)$/m);
          if (match) groupPid = Number(match[1]);
        }
        if (groupPid && !groupVerifiedGone) {
          try {
            process.kill(-groupPid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH")
              groupVerifiedGone = true;
          }
        }
        // An unresolved group, including a marker without a group PID, keeps
        // the private fixture and ownership record for manual inspection.
        const safeToRemove =
          helperSettled &&
          !markerUnreadable &&
          (groupPid ? groupVerifiedGone : !marker);
        if (!helperSettled && child) {
          child.unref();
          child.stderr?.destroy();
          if (child.connected) {
            try {
              child.disconnect();
            } catch {}
          }
        }
        server.closeAllConnections();
        try {
          if (server.listening)
            await bounded(
              new Promise<void>((resolve) => server.close(() => resolve())),
              2000,
              "server cleanup",
            );
        } finally {
          if (safeToRemove) await rm(dir, { recursive: true, force: true });
        }
        if (!safeToRemove)
          throw new Error(
            `Fixture cleanup unverified; inspect owner and group before removing ${dir}`,
          );
      }
    },
  );
}
