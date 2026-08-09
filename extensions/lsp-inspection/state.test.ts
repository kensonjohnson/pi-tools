import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  emptyLspInventory,
  ensureLspPrivateState,
  LspPrivateStateError,
  managedServerDirectory,
  managedServerExecutablePath,
  readLspInventory,
  resolveLspPrivateStatePaths,
  writeLspInventory,
} from "./state.ts";

test("private LSP state uses an agent-owned root, private modes, and atomic inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-state-"));
  const paths = resolveLspPrivateStatePaths({ agentDir: join(root, "agent") });
  try {
    await ensureLspPrivateState(paths);
    const executablePath = managedServerExecutablePath(
      paths,
      "python",
      "1.1.411",
    );
    const inventory = {
      ...emptyLspInventory(),
      servers: {
        python: {
          activeVersion: "1.1.411",
          installations: {
            "1.1.411": {
              catalogId: "python" as const,
              version: "1.1.411",
              executablePath,
              installedAtMs: 100,
              source: { kind: "npm" as const, version: "1.1.411" },
              health: { checkedAtMs: 101, version: "1.1.411" },
            },
          },
        },
      },
    };
    await writeLspInventory(paths, inventory);
    assert.deepEqual(await readLspInventory(paths), inventory);
    assert.deepEqual(
      JSON.parse(await readFile(paths.inventory, "utf8")),
      inventory,
    );
    assert.equal((await stat(paths.root)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.installations)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.inventory)).mode & 0o777, 0o600);

    await chmod(paths.inventory, 0o644);
    await writeLspInventory(paths, inventory);
    assert.equal((await stat(paths.inventory)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private LSP state rejects traversal, unsafe inventory paths, and malformed files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-state-invalid-"));
  const paths = resolveLspPrivateStatePaths({ agentDir: join(root, "agent") });
  try {
    assert.throws(
      () =>
        resolveLspPrivateStatePaths({
          agentDir: join(root, "project", "agent"),
          projectRoot: join(root, "project"),
        }),
      LspPrivateStateError,
    );
    assert.throws(
      () => managedServerDirectory(paths, "../python" as "python", "1.1.411"),
      LspPrivateStateError,
    );
    assert.throws(
      () => managedServerDirectory(paths, "python", "../../outside"),
      LspPrivateStateError,
    );

    await ensureLspPrivateState(paths);
    await writeFile(paths.inventory, "{ not valid json", { mode: 0o600 });
    await assert.rejects(readLspInventory(paths), LspPrivateStateError);

    const unsafe = {
      version: 1,
      servers: {
        python: {
          activeVersion: "1.1.411",
          installations: {
            "1.1.411": {
              catalogId: "python",
              version: "1.1.411",
              executablePath: "/tmp/not-managed/pyright-langserver",
              installedAtMs: 1,
              source: { kind: "npm", version: "1.1.411" },
              health: { checkedAtMs: 1, version: "1.1.411" },
            },
          },
        },
      },
    };
    await assert.rejects(
      writeLspInventory(paths, unsafe),
      LspPrivateStateError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
