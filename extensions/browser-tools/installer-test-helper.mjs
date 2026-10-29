import { appendFile, access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ChromiumInstaller,
  runInstallCommand,
  runPlaywrightInstall,
} from "./installer.ts";

const dir = process.argv[2];
const installer = new ChromiumInstaller({
  platform: "darwin",
  lockPath: join(dir, "lock.sqlite"),
  exists: async () =>
    access(join(dir, "installed")).then(
      () => true,
      () => false,
    ),
  run: async (signal, progress, recordGroup) => {
    await appendFile(join(dir, "calls"), "run\n");
    if (process.argv[3] === "actual") {
      await runPlaywrightInstall(signal, progress, (pid) => {
        recordGroup(pid);
        process.send?.({ group: pid });
      });
    } else if (process.argv[3] === "group") {
      await runInstallCommand(
        process.execPath,
        ["-e", "setTimeout(() => {}, 1200)"],
        signal,
        progress,
        recordGroup,
      );
    } else await new Promise((resolve) => setTimeout(resolve, 500));
    await writeFile(join(dir, "installed"), "ok");
  },
});
const controller = new AbortController();
process.on("message", (message) => {
  if (message === "cancel") controller.abort();
});
const result = await installer.ensure({
  signal: controller.signal,
  trusted: true,
  autoInstall: true,
  timeoutMs: 4000,
});
if (!result.ok) {
  console.error(result.message);
  process.exitCode = 1;
}
// Allow the shared flight to finish process-group cleanup after a waiter cancels.
if (controller.signal.aborted)
  await new Promise((resolve) => setTimeout(resolve, 1800));
process.disconnect?.();
