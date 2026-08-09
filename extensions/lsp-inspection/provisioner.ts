import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getLspCatalogDescriptor,
  type LspCatalogDescriptor,
  type LspCatalogId,
} from "./catalog.ts";
import {
  ensureLspPrivateState,
  managedServerDirectory,
  managedServerExecutablePath,
  readLspInventory,
  type ManagedServerInstallation,
  type LspPrivateStatePaths,
  writeLspInventory,
} from "./state.ts";

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export type LspProvisioningFailure =
  | "offline"
  | "install-failed"
  | "integrity-failed"
  | "probe-failed"
  | "cancelled"
  | "inventory-invalid";

export type LspProvisioningResult =
  | {
      available: true;
      source: "cached" | "installed";
      installation: ManagedServerInstallation;
    }
  | { available: false; reason: LspProvisioningFailure; message: string };

export type LspCommand = {
  command: string;
  arguments: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
};

export type LspCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type LspCommandRunner = {
  run(command: LspCommand): Promise<LspCommandResult>;
};

export type ManagedLspProvisionerOptions = {
  paths: LspPrivateStatePaths;
  runner?: LspCommandRunner;
  now?: () => number;
};

type InFlightProvisioning = {
  controller: AbortController;
  promise: Promise<LspProvisioningResult>;
};

/**
 * Installs only the reviewed catalog into Pi-owned versioned directories.
 * The injectable runner keeps tests network-free and lets the lifecycle own
 * cancellation without exposing command or source configuration to projects.
 */
export class ManagedLspProvisioner {
  readonly #paths: LspPrivateStatePaths;
  readonly #runner: LspCommandRunner;
  readonly #now: () => number;
  readonly #inFlight = new Map<LspCatalogId, InFlightProvisioning>();

  constructor(options: ManagedLspProvisionerOptions) {
    this.#paths = options.paths;
    this.#runner = options.runner ?? systemLspCommandRunner;
    this.#now = options.now ?? Date.now;
  }

  ensure(
    catalogId: LspCatalogId,
    options: { signal?: AbortSignal } = {},
  ): Promise<LspProvisioningResult> {
    if (options.signal?.aborted) return Promise.resolve(cancelledResult());

    let inFlight = this.#inFlight.get(catalogId);
    const ownsCancellation = !inFlight;
    if (!inFlight) {
      const controller = new AbortController();
      const promise = this.#ensure(catalogId, controller.signal).finally(() => {
        this.#inFlight.delete(catalogId);
      });
      inFlight = { controller, promise };
      this.#inFlight.set(catalogId, inFlight);
    }
    return joinProvisioning(inFlight, options.signal, ownsCancellation);
  }

  async #ensure(
    catalogId: LspCatalogId,
    signal: AbortSignal,
  ): Promise<LspProvisioningResult> {
    const descriptor = getLspCatalogDescriptor(catalogId);
    let inventory;
    try {
      await ensureLspPrivateState(this.#paths);
      inventory = await readLspInventory(this.#paths);
    } catch (error) {
      return failure("inventory-invalid", errorMessage(error));
    }

    const active =
      inventory.servers[catalogId]?.installations[
        inventory.servers[catalogId]?.activeVersion ?? ""
      ];
    if (active?.version === descriptor.version) {
      const health = await this.#probe(
        descriptor,
        active.executablePath,
        signal,
      );
      if (health.ok) {
        const refreshed: ManagedServerInstallation = {
          ...active,
          health: { checkedAtMs: this.#now(), version: descriptor.version },
        };
        inventory.servers[catalogId]!.installations[descriptor.version] =
          refreshed;
        try {
          await writeLspInventory(this.#paths, inventory);
          return { available: true, source: "cached", installation: refreshed };
        } catch (error) {
          return failure("inventory-invalid", errorMessage(error));
        }
      }
      if (health.reason === "cancelled") return cancelledResult();
    }

    return this.#install(descriptor, inventory, signal);
  }

  async #install(
    descriptor: LspCatalogDescriptor,
    inventory: Awaited<ReturnType<typeof readLspInventory>>,
    signal: AbortSignal,
  ): Promise<LspProvisioningResult> {
    const stage = join(
      this.#paths.installations,
      `.staging-${descriptor.id}-${process.pid}-${randomUUID()}`,
    );
    const finalDirectory = managedServerDirectory(
      this.#paths,
      descriptor.id,
      descriptor.version,
    );
    let promoted = false;
    try {
      throwIfAborted(signal);
      await makePrivateDirectory(stage);
      const installed = await this.#installIntoStage(descriptor, stage, signal);
      if (!installed.ok) return installed;

      const integrity = await readSourceIntegrity(descriptor, stage);
      if (!integrity.ok) return integrity;

      const stagedExecutable = join(
        stage,
        ...descriptor.executable.relativePath.split("/"),
      );
      const health = await this.#probe(descriptor, stagedExecutable, signal);
      if (!health.ok) return health;

      throwIfAborted(signal);
      await makePrivateDirectory(dirname(finalDirectory));
      // A same-version directory can only be stale or a previously invalid
      // active entry: a valid active entry was returned from the cache path.
      await rm(finalDirectory, { recursive: true, force: true });
      await rename(stage, finalDirectory);
      promoted = true;

      const installation: ManagedServerInstallation = {
        catalogId: descriptor.id,
        version: descriptor.version,
        executablePath: managedServerExecutablePath(
          this.#paths,
          descriptor.id,
          descriptor.version,
        ),
        installedAtMs: this.#now(),
        source: {
          kind: descriptor.source.kind,
          version: sourceVersion(descriptor),
          ...(integrity.integrity ? { integrity: integrity.integrity } : {}),
        },
        health: { checkedAtMs: this.#now(), version: descriptor.version },
      };
      const previous = inventory.servers[descriptor.id];
      inventory.servers[descriptor.id] = {
        activeVersion: descriptor.version,
        installations: {
          ...previous?.installations,
          [descriptor.version]: installation,
        },
      };
      await writeLspInventory(this.#paths, inventory);
      return { available: true, source: "installed", installation };
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return cancelledResult();
      return failure("install-failed", errorMessage(error));
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
      // Do not leave an untracked promoted directory after an inventory write
      // failure; previous valid inventory remains untouched in that case.
      if (promoted) {
        const current = await readLspInventory(this.#paths).catch(
          () => undefined,
        );
        if (
          !current?.servers[descriptor.id]?.installations[descriptor.version]
        ) {
          await rm(finalDirectory, { recursive: true, force: true }).catch(
            () => {},
          );
        }
      }
    }
  }

  async #installIntoStage(
    descriptor: LspCatalogDescriptor,
    stage: string,
    signal: AbortSignal,
  ): Promise<LspProvisioningResult | { ok: true }> {
    const command = installCommand(descriptor, stage, signal);
    try {
      const result = await this.#runner.run(command);
      if (result.code === 0) return { ok: true };
      return failure(
        classifyCommandFailure(result),
        commandFailureMessage(result),
      );
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return cancelledResult();
      return failure(classifyError(error), errorMessage(error));
    }
  }

  async #probe(
    descriptor: LspCatalogDescriptor,
    executablePath: string,
    signal: AbortSignal,
  ): Promise<{ ok: true } | LspProvisioningResult> {
    try {
      const result = await this.#runner.run({
        command: executablePath,
        arguments: descriptor.healthProbe.arguments,
        signal,
      });
      if (
        result.code === 0 &&
        containsExpectedVersion(
          `${result.stdout}\n${result.stderr}`,
          descriptor.healthProbe.expectedVersion,
        )
      ) {
        return { ok: true };
      }
      return failure("probe-failed", commandFailureMessage(result));
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return cancelledResult();
      return failure("probe-failed", errorMessage(error));
    }
  }
}

/** Build the reviewed installation command without accepting arbitrary input. */
export function installCommand(
  descriptor: LspCatalogDescriptor,
  stage: string,
  signal?: AbortSignal,
): LspCommand {
  if (descriptor.source.kind === "npm") {
    return {
      command: "npm",
      arguments: [
        "install",
        "--prefix",
        stage,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=true",
        ...descriptor.source.packages.map(
          (pkg) => `${pkg.name}@${pkg.version}`,
        ),
      ],
      signal,
    };
  }
  return {
    command: "go",
    arguments: [
      "install",
      `${descriptor.source.module}@${descriptor.source.version}`,
    ],
    env: { GOBIN: join(stage, "bin") },
    signal,
  };
}

export const systemLspCommandRunner: LspCommandRunner = {
  run(command) {
    return runSystemCommand(command);
  },
};

async function readSourceIntegrity(
  descriptor: LspCatalogDescriptor,
  stage: string,
): Promise<{ ok: true; integrity?: string } | LspProvisioningResult> {
  if (descriptor.source.kind === "go") return { ok: true };
  try {
    const lock = JSON.parse(
      await readFile(join(stage, "package-lock.json"), "utf8"),
    ) as {
      packages?: Record<string, { version?: unknown; integrity?: unknown }>;
    };
    const primary = descriptor.source.packages[0];
    const entry = npmLockEntry(lock.packages, primary.name);
    if (
      entry?.version !== primary.version ||
      typeof entry.integrity !== "string" ||
      entry.integrity.length === 0
    ) {
      return failure(
        "integrity-failed",
        "Pinned npm package integrity is missing or invalid.",
      );
    }
    return { ok: true, integrity: entry.integrity };
  } catch (error) {
    return failure("integrity-failed", errorMessage(error));
  }
}

function npmLockEntry(
  packages:
    Record<string, { version?: unknown; integrity?: unknown }> | undefined,
  packageName: string,
): { version?: unknown; integrity?: unknown } | undefined {
  const expectedPath = `node_modules/${packageName}`;
  return (
    packages?.[expectedPath] ??
    Object.entries(packages ?? {}).find(([path]) =>
      path.replaceAll("\\", "/").endsWith(`/${expectedPath}`),
    )?.[1]
  );
}

function joinProvisioning(
  inFlight: InFlightProvisioning,
  signal: AbortSignal | undefined,
  ownsCancellation: boolean,
): Promise<LspProvisioningResult> {
  if (!signal) return inFlight.promise;
  return new Promise((resolve) => {
    const onAbort = () => {
      // The creator owns the child process. A later tool caller may leave the
      // shared operation, but must not cancel session-start provisioning.
      if (ownsCancellation) inFlight.controller.abort();
      resolve(cancelledResult());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    inFlight.promise.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(signal.aborted ? cancelledResult() : result);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(
          signal.aborted
            ? cancelledResult()
            : failure("install-failed", "Provisioning failed."),
        );
      },
    );
  });
}

async function makePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => {});
}

function runSystemCommand(command: LspCommand): Promise<LspCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.arguments], {
      cwd: command.cwd,
      env: command.env ? { ...process.env, ...command.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current: string, chunk: Buffer) =>
      `${current}${chunk.toString("utf8")}`.slice(-MAX_COMMAND_OUTPUT_BYTES);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      command.signal?.removeEventListener("abort", abort);
      fn();
    };
    const abort = () => {
      child.kill();
      finish(() => reject(new LspProvisioningCancelledError()));
    };
    if (command.signal?.aborted) return abort();
    command.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) =>
      finish(() => resolve({ code, stdout, stderr })),
    );
  });
}

class LspProvisioningCancelledError extends Error {
  constructor() {
    super("LSP provisioning cancelled.");
    this.name = "LspProvisioningCancelledError";
  }
}

function sourceVersion(descriptor: LspCatalogDescriptor): string {
  return descriptor.source.kind === "npm"
    ? descriptor.source.packages[0].version
    : descriptor.source.version;
}

function containsExpectedVersion(output: string, expected: string): boolean {
  return new RegExp(
    `(^|[^0-9A-Za-z._+-])${escapeRegExp(expected)}($|[^0-9A-Za-z._+-])`,
  ).test(output);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new LspProvisioningCancelledError();
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof LspProvisioningCancelledError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

function cancelledResult(): LspProvisioningResult {
  return failure("cancelled", "LSP provisioning was cancelled.");
}

function failure(
  reason: LspProvisioningFailure,
  message: string,
): LspProvisioningResult {
  return { available: false, reason, message };
}

function classifyCommandFailure(
  result: LspCommandResult,
): LspProvisioningFailure {
  return /ENETUNREACH|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|network|offline/i.test(
    `${result.stdout}\n${result.stderr}`,
  )
    ? "offline"
    : "install-failed";
}

function classifyError(error: unknown): LspProvisioningFailure {
  return /ENETUNREACH|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|network|offline/i.test(
    errorMessage(error),
  )
    ? "offline"
    : "install-failed";
}

function commandFailureMessage(result: LspCommandResult): string {
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  return detail || `Command exited with status ${result.code ?? "unknown"}.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
