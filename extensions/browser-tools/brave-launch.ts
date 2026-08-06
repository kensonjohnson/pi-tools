import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

export type BraveLaunchOptions = {
  executable: string;
  args: string[];
  spawnOptions: SpawnOptions;
  spawnProcess?: typeof spawn;
};

function formatLaunchError(error: unknown, executable: string): Error {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  ) {
    return new Error(
      `Brave could not be started because its executable was not found at ${executable}. Browser Tools currently expects the macOS Brave application bundle.`,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to start Brave: ${message}`);
}

/**
 * Starts Brave while permanently consuming child-process errors so a missing
 * executable cannot surface as an unhandled Node "error" event.
 */
export function launchBrave(
  options: BraveLaunchOptions,
): Promise<ChildProcess> {
  const spawnProcess = options.spawnProcess ?? spawn;
  const child = spawnProcess(
    options.executable,
    options.args,
    options.spawnOptions,
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    const rejectLaunch = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(formatLaunchError(error, options.executable));
      }
    };

    child.once("spawn", () => {
      if (!settled) {
        settled = true;
        resolve(child);
      }
    });
    child.on("error", rejectLaunch);
  });
}
