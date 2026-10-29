import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ManagedSessions } from "../../extensions/browser-tools/sessions.ts";

type ProcessInfo = {
  pid: number;
  ppid: number;
  started: string;
  command: string;
};

function processes(): ProcessInfo[] {
  const output = execFileSync(
    "ps",
    ["-axww", "-o", "pid=,ppid=,lstart=,command="],
    { encoding: "utf8" },
  );
  return output.split("\n").flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/,
    );
    return match
      ? [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            started: match[3].replace(/\s+/g, " "),
            command: match[4],
          },
        ]
      : [];
  });
}

function descendants(snapshot: ProcessInfo[], root: number): ProcessInfo[] {
  const parents = new Set([root]);
  const result: ProcessInfo[] = [];
  let added: boolean;
  do {
    added = false;
    for (const process of snapshot) {
      if (
        process.pid !== root &&
        parents.has(process.ppid) &&
        !parents.has(process.pid)
      ) {
        parents.add(process.pid);
        result.push(process);
        added = true;
      }
    }
  } while (added);
  return result;
}

for (const mode of ["broken-pipe", "timeout"] as const)
  test(
    `real Chromium ${mode} after spawn leaves its observed root process exited`,
    { timeout: 20_000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "browser-launch-failure-"));
      const previousTmp = process.env.TMPDIR;
      const pidFile = join(dir, "pid");
      const wrapper = join(dir, "chromium-wrapper");
      let rawError = "";
      // exec preserves the PID. Breaking input causes exit; discarding output stalls
      // the protocol until Playwright's launch timeout expires.
      const redirect =
        mode === "broken-pipe" ? "3</dev/null 4>/dev/null" : "4>/dev/null";
      await writeFile(
        wrapper,
        `#!/bin/sh\necho $$ > "$TEST_PID_FILE"\nexec "$TEST_CHROMIUM" "$@" ${redirect}\n`,
      );
      await chmod(wrapper, 0o700);
      process.env.TMPDIR = dir;
      const runtime = new ManagedSessions({
        launch: async ({ headless }) => {
          try {
            return await chromium.launch({
              channel: "chromium",
              headless,
              executablePath: wrapper,
              timeout: 2_000,
              env: {
                ...process.env,
                TEST_PID_FILE: pidFile,
                TEST_CHROMIUM: chromium.executablePath(),
              },
            });
          } catch (error) {
            rawError = String(error);
            throw error;
          }
        },
      });
      try {
        const startup = runtime.start({ headless: true });
        const rejected = assert.rejects(
          startup,
          /cleanup could not be verified/,
        );
        const observed = new Map<string, ProcessInfo>();
        let identified = false;
        let settled = false;
        void startup.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const appPath = chromium.executablePath().split(".app/")[0] + ".app/";
        while (!settled) {
          let pid = 0;
          try {
            pid = Number((await readFile(pidFile, "utf8")).trim());
          } catch {
            /* not written yet */
          }
          if (Number.isSafeInteger(pid) && pid > 0) {
            const snapshot = processes();
            const root = snapshot.find((process) => process.pid === pid);
            if (
              root?.command.includes(chromium.executablePath()) &&
              root.command.includes(dir)
            ) {
              identified = true;
              for (const process of [root, ...descendants(snapshot, pid)]) {
                if (process.command.includes(appPath))
                  observed.set(`${process.pid}:${process.started}`, process);
              }
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        await rejected;
        if (mode === "timeout")
          assert(
            identified,
            "the recorded PID must be pinned Chromium before timeout",
          );
        const pid = Number((await readFile(pidFile, "utf8")).trim());
        assert(Number.isSafeInteger(pid) && pid > 0);
        assert.match(rawError, new RegExp(`<launched> pid=${pid}\\b`));
        if (mode === "timeout")
          assert.match(rawError, /Timeout 2000ms exceeded/);
        assert.match(rawError, /--user-data-dir=/);
        assert(
          rawError.includes(dir),
          "Playwright profile must be under the isolated temp directory",
        );
        assert.deepEqual(runtime.list(), []);
        assert.equal((await runtime.shutdown()).complete, false);
        let remaining = [...observed.values()];
        for (let i = 0; i < 100 && remaining.length; i++) {
          const live = processes();
          remaining = remaining.filter((seen) =>
            live.some(
              (current) =>
                current.pid === seen.pid && current.started === seen.started,
            ),
          );
          if (remaining.length)
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        t.diagnostic(
          `captured Chromium root=${observed.has([...observed.keys()].find((key) => key.startsWith(`${pid}:`)) ?? "")} children=${
            [...observed.values()]
              .filter((process) => process.pid !== pid)
              .map((process) => process.pid)
              .join(",") || "none"
          }`,
        );
        assert.deepEqual(
          remaining.map((process) => `${process.pid}:${process.started}`),
          [],
          "captured Chromium identities must exit",
        );
        // Fast failure may precede the first snapshot; check only the logged root
        // then, without signalling or attempting to kill an unverified PID.
        if (!identified) {
          assert(
            !processes().some((process) => process.pid === pid),
            `launch PID ${pid} still exists`,
          );
        }
      } finally {
        await runtime.shutdown();
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
