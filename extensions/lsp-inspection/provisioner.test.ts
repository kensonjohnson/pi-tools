import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  LspCommand,
  LspCommandResult,
  LspCommandRunner,
} from "./provisioner.ts";
import {
  installCommand,
  ManagedLspProvisioner,
  type LspProvisioningResult,
} from "./provisioner.ts";
import { getLspCatalogDescriptor } from "./catalog.ts";
import {
  emptyLspInventory,
  managedServerExecutablePath,
  readLspInventory,
  resolveLspPrivateStatePaths,
  writeLspInventory,
} from "./state.ts";

test("provisioner uses only reviewed npm and Go commands, validates them, and caches the managed executable", async () => {
  await withState(async (paths) => {
    const runner = new FakeRunner();
    const provisioner = new ManagedLspProvisioner({
      paths,
      runner,
      now: clock(),
    });

    const installed = await provisioner.ensure("typescript");
    assertAvailable(installed, "installed");
    assert.equal(
      installed.installation.executablePath,
      managedServerExecutablePath(paths, "typescript", "5.3.0"),
    );
    assert.equal(
      installed.installation.source.integrity,
      "sha512-typescript-language-server",
    );
    assert.deepEqual(runner.commands[0], {
      command: "npm",
      arguments: [
        "install",
        "--prefix",
        runner.stageDirectories[0],
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=true",
        "typescript-language-server@5.3.0",
        "typescript@5.9.3",
      ],
    });
    assert.deepEqual(runner.commands[1], {
      command: join(
        runner.stageDirectories[0],
        "node_modules/.bin/typescript-language-server",
      ),
      arguments: ["--version"],
    });

    const cached = await provisioner.ensure("typescript");
    assertAvailable(cached, "cached");
    assert.equal(runner.commands.length, 3);
    assert.equal(
      runner.commands[2].command,
      installed.installation.executablePath,
    );

    const goRunner = new FakeRunner();
    const goProvisioner = new ManagedLspProvisioner({
      paths,
      runner: goRunner,
    });
    const go = await goProvisioner.ensure("go");
    assertAvailable(go, "installed");
    assert.deepEqual(goRunner.commands[0], {
      command: "go",
      arguments: ["install", "golang.org/x/tools/gopls@v0.23.0"],
      env: { GOBIN: join(goRunner.stageDirectories[0], "bin") },
    });
    assert.deepEqual(goRunner.commands[1], {
      command: join(goRunner.stageDirectories[0], "bin/gopls"),
      arguments: ["version"],
    });
  });
});

test("npm install omits --no-save so integrity validates against its root lockfile", async () => {
  await withState(async (paths) => {
    const runner = new FakeRunner();
    const result = await new ManagedLspProvisioner({ paths, runner }).ensure(
      "typescript",
    );

    assertAvailable(result, "installed");
    assert.equal(runner.commands[0]!.arguments.includes("--no-save"), false);
  });
});

test("concurrent callers share one staged install and recover after a failed stage", async () => {
  await withState(async (paths) => {
    const runner = new FakeRunner({ holdInstalls: true });
    const provisioner = new ManagedLspProvisioner({ paths, runner });
    const first = provisioner.ensure("python");
    const second = provisioner.ensure("python");
    assert.strictEqual(first, second);
    await runner.waitForInstall();
    assert.equal(runner.installCalls, 1);
    runner.releaseInstall();
    assertAvailable(await first, "installed");

    runner.options.holdInstalls = false;
    runner.failNextInstall = true;
    const failed = await provisioner.ensure("go");
    assertFailure(failed, "install-failed");
    const recovered = await provisioner.ensure("go");
    assertAvailable(recovered, "installed");
    assert.equal(runner.installCalls, 3);
  });
});

test("a later cancelled caller leaves the creator-owned shared install running", async () => {
  await withState(async (paths) => {
    const runner = new FakeRunner({ holdInstalls: true });
    const provisioner = new ManagedLspProvisioner({ paths, runner });
    const session = new AbortController();
    const background = provisioner.ensure("python", { signal: session.signal });
    await runner.waitForInstall();

    const tool = new AbortController();
    const inspection = provisioner.ensure("python", { signal: tool.signal });
    tool.abort();
    assertFailure(await inspection, "cancelled");
    assert.equal(runner.abortCalls, 0);

    runner.releaseInstall();
    assertAvailable(await background, "installed");
  });
});

test("failed replacement retains the previous working inventory and malformed inventory never runs a command", async () => {
  await withState(async (paths) => {
    const previousPath = managedServerExecutablePath(
      paths,
      "python",
      "1.1.410",
    );
    const previous = {
      ...emptyLspInventory(),
      servers: {
        python: {
          activeVersion: "1.1.410",
          installations: {
            "1.1.410": {
              catalogId: "python" as const,
              version: "1.1.410",
              executablePath: previousPath,
              installedAtMs: 10,
              source: { kind: "npm" as const, version: "1.1.410" },
              health: { checkedAtMs: 11, version: "1.1.410" },
            },
          },
        },
      },
    };
    await writeLspInventory(paths, previous);
    const runner = new FakeRunner({ failInstalls: true });
    const provisioner = new ManagedLspProvisioner({ paths, runner });
    assertFailure(await provisioner.ensure("python"), "install-failed");
    assert.deepEqual(await readLspInventory(paths), previous);

    await writeFile(paths.inventory, "{ malformed", { mode: 0o600 });
    const malformedRunner = new FakeRunner();
    const malformed = await new ManagedLspProvisioner({
      paths,
      runner: malformedRunner,
    }).ensure("python");
    assertFailure(malformed, "inventory-invalid");
    assert.equal(malformedRunner.commands.length, 0);
  });
});

test("integrity, offline, probe, and cancelled failures leave inventory untouched", async () => {
  await withState(async (paths) => {
    const integrity = new FakeRunner({ omitIntegrity: true });
    assertFailure(
      await new ManagedLspProvisioner({ paths, runner: integrity }).ensure(
        "python",
      ),
      "integrity-failed",
    );
    assert.deepEqual(await readLspInventory(paths), emptyLspInventory());

    const offline = new FakeRunner({ offlineInstalls: true });
    assertFailure(
      await new ManagedLspProvisioner({ paths, runner: offline }).ensure(
        "python",
      ),
      "offline",
    );
    assert.deepEqual(await readLspInventory(paths), emptyLspInventory());

    const probe = new FakeRunner({ badProbe: true });
    assertFailure(
      await new ManagedLspProvisioner({ paths, runner: probe }).ensure(
        "python",
      ),
      "probe-failed",
    );
    assert.deepEqual(await readLspInventory(paths), emptyLspInventory());

    const cancelled = new FakeRunner({ holdInstalls: true });
    const controller = new AbortController();
    const promise = new ManagedLspProvisioner({
      paths,
      runner: cancelled,
    }).ensure("python", { signal: controller.signal });
    await cancelled.waitForInstall();
    controller.abort();
    assertFailure(await promise, "cancelled");
    assert.equal(cancelled.abortCalls, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await readLspInventory(paths), emptyLspInventory());
  });
});

test("install command accepts a descriptor only and has no shell expansion", () => {
  const python = getLspCatalogDescriptor("python");
  const command = installCommand(python, "/private/lsp/stage");
  assert.equal(command.command, "npm");
  assert.deepEqual(command.arguments.slice(-1), ["pyright@1.1.411"]);
  assert.equal(
    command.arguments.some((argument) => argument.includes(";")),
    false,
  );
});

class FakeRunner implements LspCommandRunner {
  readonly commands: Array<Pick<LspCommand, "command" | "arguments" | "env">> =
    [];
  readonly stageDirectories: string[] = [];
  readonly options: {
    holdInstalls?: boolean;
    failInstalls?: boolean;
    offlineInstalls?: boolean;
    omitIntegrity?: boolean;
    badProbe?: boolean;
  };
  installCalls = 0;
  abortCalls = 0;
  failNextInstall = false;
  #release: (() => void) | undefined;
  #installed: (() => void) | undefined;
  #installStarted = false;

  constructor(options: FakeRunner["options"] = {}) {
    this.options = options;
  }

  async run(command: LspCommand): Promise<LspCommandResult> {
    this.commands.push({
      command: command.command,
      arguments: [...command.arguments],
      ...(command.env ? { env: command.env } : {}),
    });
    if (command.command === "npm" || command.command === "go") {
      this.installCalls += 1;
      const stage = stageDirectory(command);
      this.stageDirectories.push(stage);
      this.#installStarted = true;
      this.#installed?.();
      if (this.options.holdInstalls) await this.#waitForRelease(command.signal);
      if (this.options.offlineInstalls)
        return { code: 1, stdout: "", stderr: "ENETUNREACH offline" };
      if (this.options.failInstalls || this.failNextInstall) {
        this.failNextInstall = false;
        return { code: 1, stdout: "", stderr: "installation failed" };
      }
      if (command.command === "npm") {
        // npm --no-save succeeds without creating the root lockfile.
        if (!command.arguments.includes("--no-save")) {
          await this.#writeNpmLock(command, stage);
        }
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (this.options.badProbe)
      return { code: 0, stdout: "unexpected version", stderr: "" };
    return {
      code: 0,
      stdout: expectedVersionForCommand(command.command),
      stderr: "",
    };
  }

  waitForInstall(): Promise<void> {
    if (this.#installStarted) return Promise.resolve();
    return new Promise((resolve) => {
      this.#installed = resolve;
    });
  }

  releaseInstall(): void {
    this.#release?.();
  }

  async #writeNpmLock(command: LspCommand, stage: string): Promise<void> {
    const spec = command.arguments.find((argument) =>
      argument.includes("@", 1),
    );
    const split = spec!.lastIndexOf("@");
    const name = spec!.slice(0, split);
    const version = spec!.slice(split + 1);
    await writeFile(
      join(stage, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          [join(stage, "node_modules", name)]: {
            version,
            ...(this.options.omitIntegrity
              ? {}
              : { integrity: `sha512-${name}` }),
          },
        },
      }),
    );
  }

  #waitForRelease(signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.abortCalls += 1;
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      this.#release = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
    });
  }
}

function stageDirectory(command: LspCommand): string {
  if (command.command === "go")
    return command.env!.GOBIN!.slice(0, -"/bin".length);
  const prefix = command.arguments.indexOf("--prefix");
  return command.arguments[prefix + 1]!;
}

function expectedVersionForCommand(command: string): string {
  if (command.includes("gopls")) return "golang.org/x/tools/gopls v0.23.0";
  if (command.includes("typescript-language-server")) return "5.3.0";
  return "1.1.411";
}

function assertAvailable(
  result: LspProvisioningResult,
  source: "cached" | "installed",
): asserts result is Extract<LspProvisioningResult, { available: true }> {
  assert.equal(result.available, true, JSON.stringify(result));
  if (result.available) assert.equal(result.source, source);
}

function assertFailure(result: LspProvisioningResult, reason: string): void {
  assert.equal(result.available, false, JSON.stringify(result));
  if (!result.available) assert.equal(result.reason, reason);
}

function clock(): () => number {
  let value = 100;
  return () => value++;
}

async function withState(
  body: (
    paths: ReturnType<typeof resolveLspPrivateStatePaths>,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-provisioner-"));
  try {
    await body(resolveLspPrivateStatePaths({ agentDir: join(root, "agent") }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
