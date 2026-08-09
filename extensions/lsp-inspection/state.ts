import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  getLspCatalogDescriptor,
  isLspCatalogId,
  type LspCatalogId,
} from "./catalog.ts";

export const LSP_MANAGED_ROOT_NAME = "lsp-inspection";
export const LSP_INVENTORY_FILE_NAME = "inventory.json";
export const LSP_INVENTORY_VERSION = 1;

export type LspPrivateStatePaths = {
  root: string;
  installations: string;
  inventory: string;
};

export type ManagedServerInstallation = {
  catalogId: LspCatalogId;
  version: string;
  executablePath: string;
  installedAtMs: number;
  source: {
    kind: "npm" | "go";
    version: string;
    integrity?: string;
  };
  health: {
    checkedAtMs: number;
    version: string;
  };
};

export type ManagedServerRecord = {
  activeVersion: string;
  installations: Record<string, ManagedServerInstallation>;
};

export type LspInventory = {
  version: typeof LSP_INVENTORY_VERSION;
  servers: Partial<Record<LspCatalogId, ManagedServerRecord>>;
};

export class LspPrivateStateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LspPrivateStateError";
  }
}

export function resolveLspPrivateStatePaths(
  options: {
    agentDir?: string;
    projectRoot?: string;
  } = {},
): LspPrivateStatePaths {
  const agentDir =
    options.agentDir ??
    process.env.PI_CODING_AGENT_DIR ??
    join(homedir(), ".pi", "agent");
  if (!isAbsolute(agentDir)) {
    throw new LspPrivateStateError("The Pi agent directory must be absolute.");
  }

  const root = join(agentDir, LSP_MANAGED_ROOT_NAME);
  if (options.projectRoot && pathIsWithin(options.projectRoot, root)) {
    throw new LspPrivateStateError(
      "The LSP managed root must not be inside the project tree.",
    );
  }
  return {
    root,
    installations: join(root, "servers"),
    inventory: join(root, LSP_INVENTORY_FILE_NAME),
  };
}

export function managedServerDirectory(
  paths: LspPrivateStatePaths,
  catalogId: LspCatalogId,
  version: string,
): string {
  assertCatalogId(catalogId);
  assertSafeVersion(version);
  return privatePath(paths.installations, catalogId, version);
}

export function managedServerExecutablePath(
  paths: LspPrivateStatePaths,
  catalogId: LspCatalogId,
  version: string,
): string {
  const descriptor = getLspCatalogDescriptor(catalogId);
  return privatePath(
    managedServerDirectory(paths, catalogId, version),
    ...descriptor.executable.relativePath.split("/"),
  );
}

export async function ensureLspPrivateState(
  paths: LspPrivateStatePaths,
): Promise<void> {
  assertStatePaths(paths);
  await ensurePrivateDirectory(paths.root);
  await ensurePrivateDirectory(paths.installations);
}

export function emptyLspInventory(): LspInventory {
  return { version: LSP_INVENTORY_VERSION, servers: {} };
}

export async function readLspInventory(
  paths: LspPrivateStatePaths,
): Promise<LspInventory> {
  assertStatePaths(paths);
  try {
    const parsed = JSON.parse(
      await readFile(paths.inventory, "utf8"),
    ) as unknown;
    return parseLspInventory(paths, parsed);
  } catch (error) {
    if (isMissingFileError(error)) return emptyLspInventory();
    if (error instanceof LspPrivateStateError) throw error;
    throw new LspPrivateStateError("Could not read LSP managed inventory.", {
      cause: error,
    });
  }
}

export async function writeLspInventory(
  paths: LspPrivateStatePaths,
  inventory: LspInventory,
): Promise<void> {
  assertStatePaths(paths);
  const normalizedInventory = parseLspInventory(paths, inventory);
  await ensureLspPrivateState(paths);

  const temporary = join(
    paths.root,
    `.${LSP_INVENTORY_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(normalizedInventory, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      },
    );
    await chmodPrivate(temporary, 0o600);
    await rename(temporary, paths.inventory);
    await chmodPrivate(paths.inventory, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (error instanceof LspPrivateStateError) throw error;
    throw new LspPrivateStateError("Could not persist LSP managed inventory.", {
      cause: error,
    });
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmodPrivate(path, 0o700);
  } catch (error) {
    throw new LspPrivateStateError(
      `Could not create private LSP state directory '${path}'.`,
      { cause: error },
    );
  }
}

async function chmodPrivate(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // Windows has no POSIX permission bits.
  }
}

function parseLspInventory(
  paths: LspPrivateStatePaths,
  value: unknown,
): LspInventory {
  if (
    !isRecord(value) ||
    value.version !== LSP_INVENTORY_VERSION ||
    !isRecord(value.servers)
  ) {
    throw new LspPrivateStateError(
      "LSP managed inventory has an invalid format.",
    );
  }

  const servers: Partial<Record<LspCatalogId, ManagedServerRecord>> = {};
  for (const [catalogId, record] of Object.entries(value.servers)) {
    if (!isLspCatalogId(catalogId) || !isRecord(record)) {
      throw new LspPrivateStateError(
        "LSP managed inventory has an invalid server id.",
      );
    }
    if (
      !isSafeVersion(record.activeVersion) ||
      !isRecord(record.installations)
    ) {
      throw new LspPrivateStateError(
        "LSP managed inventory has an invalid server record.",
      );
    }

    const installations: Record<string, ManagedServerInstallation> = {};
    for (const [version, installation] of Object.entries(
      record.installations,
    )) {
      if (!isSafeVersion(version) || !isManagedInstallation(installation)) {
        throw new LspPrivateStateError(
          "LSP managed inventory has an invalid installation.",
        );
      }
      if (
        installation.catalogId !== catalogId ||
        installation.version !== version ||
        !pathIsWithin(
          managedServerDirectory(paths, catalogId, version),
          installation.executablePath,
        )
      ) {
        throw new LspPrivateStateError(
          "LSP managed inventory contains an unsafe installation path.",
        );
      }
      installations[version] = structuredClone(installation);
    }

    if (!Object.hasOwn(installations, record.activeVersion)) {
      throw new LspPrivateStateError(
        "LSP managed inventory active version is missing.",
      );
    }
    servers[catalogId] = {
      activeVersion: record.activeVersion,
      installations,
    };
  }
  return { version: LSP_INVENTORY_VERSION, servers };
}

function isManagedInstallation(
  value: unknown,
): value is ManagedServerInstallation {
  if (
    !isRecord(value) ||
    !isLspCatalogId(value.catalogId) ||
    !isSafeVersion(value.version)
  ) {
    return false;
  }
  if (
    !isAbsolute(value.executablePath) ||
    !isFiniteNonNegative(value.installedAtMs)
  ) {
    return false;
  }
  if (
    !isRecord(value.source) ||
    (value.source.kind !== "npm" && value.source.kind !== "go") ||
    !isSafeVersion(value.source.version)
  ) {
    return false;
  }
  if (
    value.source.integrity !== undefined &&
    typeof value.source.integrity !== "string"
  ) {
    return false;
  }
  return (
    isRecord(value.health) &&
    isFiniteNonNegative(value.health.checkedAtMs) &&
    typeof value.health.version === "string"
  );
}

function assertStatePaths(paths: LspPrivateStatePaths): void {
  if (
    !isAbsolute(paths.root) ||
    !isAbsolute(paths.installations) ||
    !isAbsolute(paths.inventory)
  ) {
    throw new LspPrivateStateError("LSP private state paths must be absolute.");
  }
  if (
    paths.installations !== privatePath(paths.root, "servers") ||
    paths.inventory !== privatePath(paths.root, LSP_INVENTORY_FILE_NAME)
  ) {
    throw new LspPrivateStateError("LSP private state paths are invalid.");
  }
}

function assertCatalogId(value: unknown): asserts value is LspCatalogId {
  if (!isLspCatalogId(value)) {
    throw new LspPrivateStateError("Unknown managed LSP catalog id.");
  }
}

function assertSafeVersion(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
  ) {
    throw new LspPrivateStateError(
      "Managed LSP versions must be safe path segments.",
    );
  }
}

function privatePath(root: string, ...segments: string[]): string {
  const path = resolve(root, ...segments);
  if (!pathIsWithin(root, path)) {
    throw new LspPrivateStateError(
      "LSP private state path escapes its managed root.",
    );
  }
  return path;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const contained = relative(resolve(root), resolve(candidate));
  return (
    contained === "" || (!contained.startsWith("..") && !isAbsolute(contained))
  );
}

function isSafeVersion(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
  );
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
