import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve } from "node:path";
import {
  publishExtensionSettings,
  type EffectiveSettings,
} from "../../lib/pi-tools-config.ts";
import { getRuntimeSettings } from "../../lib/pi-tools-runtime-settings.ts";
import {
  findLspCatalogForFile,
  LSP_CATALOG_IDS,
  type LspCatalogId,
} from "./catalog.ts";
import {
  LspDiagnosticInspector,
  normalizeAvailabilityDetail,
  type LspInspectionResolution,
  type LspInspectionResolver,
} from "./inspect.ts";
import {
  ManagedLspProvisioner,
  type LspProvisioningResult,
} from "./provisioner.ts";
import { LspServerManager } from "./server-manager.ts";
import {
  resolveLspPrivateStatePaths,
  type LspPrivateStatePaths,
} from "./state.ts";
import {
  LSP_INSPECTION_EXTENSION_ID,
  LSP_INSPECTION_SETTINGS,
  LSP_INSPECTION_TOOL_NAMES,
  resolveLspInspectionSettings,
  type LspInspectionSettings,
} from "./settings.ts";
import { registerLspInspectTool, type LspInspectToolRuntime } from "./tool.ts";

export type LspProvisioner = Pick<ManagedLspProvisioner, "ensure">;
export type LspServerManagerRuntime = Pick<
  LspServerManager,
  "getOrStart" | "close"
>;

export type LspInspectionExtensionOptions = {
  loadSettings?: (ctx: {
    cwd: string;
    isProjectTrusted(): boolean;
  }) => Promise<EffectiveSettings>;
  resolvePaths?: (options: { projectRoot: string }) => LspPrivateStatePaths;
  createProvisioner?: (paths: LspPrivateStatePaths) => LspProvisioner;
  createManager?: () => LspServerManagerRuntime;
};

type LspInspectionRuntime = LspInspectToolRuntime & {
  controller: AbortController;
  provisioner: LspProvisioner;
  manager: LspServerManagerRuntime;
};

function removeLspInspectTool(pi: ExtensionAPI): void {
  const owned = new Set<string>(LSP_INSPECTION_TOOL_NAMES);
  pi.setActiveTools(pi.getActiveTools().filter((name) => !owned.has(name)));
}

function addLspInspectTool(pi: ExtensionAPI): void {
  pi.setActiveTools([
    ...new Set([...pi.getActiveTools(), ...LSP_INSPECTION_TOOL_NAMES]),
  ]);
}

/**
 * Creates the trusted-session LSP runtime. The injectable construction seams
 * keep lifecycle tests network-free without permitting project configuration
 * to select a process, package, or executable.
 */
export function createLspInspectionExtension(
  pi: ExtensionAPI,
  options: LspInspectionExtensionOptions = {},
): void {
  const loadSettings =
    options.loadSettings ?? ((ctx) => getRuntimeSettings(ctx, CONFIG_DIR_NAME));
  const resolvePaths = options.resolvePaths ?? resolveLspPrivateStatePaths;
  const createProvisioner =
    options.createProvisioner ??
    ((paths) => new ManagedLspProvisioner({ paths }));
  const createManager = options.createManager ?? (() => new LspServerManager());
  let runtime: LspInspectionRuntime | undefined;
  let lifecycleVersion = 0;

  async function stopRuntime(): Promise<void> {
    const current = runtime;
    // Clear this first: all registered tools and late startup work observe the
    // invalidated runtime before installers or processes are asked to stop.
    runtime = undefined;
    removeLspInspectTool(pi);
    if (!current) return;
    current.controller.abort();
    await current.manager.close();
  }

  publishExtensionSettings(pi.events, LSP_INSPECTION_SETTINGS);
  // Pi permits tool registration while the extension factory is loading, but
  // action methods such as setActiveTools are only available after lifecycle
  // initialization. session_start removes the default activation before trust
  // or enabled-state handling below.
  registerLspInspectTool(pi, () => runtime);

  pi.on("session_start", async (_event, ctx) => {
    const version = ++lifecycleVersion;
    await stopRuntime();
    // A globally loaded extension has Node permissions even for untrusted
    // projects. Do not read project settings or create private state first.
    if (!ctx.isProjectTrusted()) return;

    const settings = resolveLspInspectionSettings(
      (await loadSettings(ctx)).values[LSP_INSPECTION_EXTENSION_ID],
    );
    if (version !== lifecycleVersion || !settings.enabled) return;

    const paths = resolvePaths({ projectRoot: ctx.cwd });
    const provisioner = createProvisioner(paths);
    const manager = createManager();
    const controller = new AbortController();
    const next: LspInspectionRuntime = {
      rootPath: ctx.cwd,
      diagnostics: settings.diagnostics,
      workspace: settings.workspace,
      controller,
      provisioner,
      manager,
      service: new LspDiagnosticInspector(
        createManagedInspectionResolver(
          ctx.cwd,
          provisioner,
          manager,
          controller.signal,
        ),
      ),
    };
    if (version !== lifecycleVersion) {
      controller.abort();
      await manager.close();
      return;
    }

    runtime = next;
    addLspInspectTool(pi);
    for (const catalogId of ensuredCatalogs(settings)) {
      // Deliberately do not await startup installs. The same provisioner
      // coalesces these promises with inspection-triggered installation.
      void provisioner
        .ensure(catalogId, { signal: controller.signal })
        .catch(() => {});
    }
  });

  pi.on("session_shutdown", async () => {
    ++lifecycleVersion;
    await stopRuntime();
  });
}

/** Resolves reviewed managed executables into session-owned LSP clients. */
export function createManagedInspectionResolver(
  rootPath: string,
  provisioner: LspProvisioner,
  manager: LspServerManagerRuntime,
  sessionSignal: AbortSignal,
): LspInspectionResolver {
  async function resolveCatalog(
    catalogId: LspCatalogId,
    options: { signal?: AbortSignal } = {},
  ): Promise<LspInspectionResolution> {
    const signal = combinedSignal(sessionSignal, options.signal);
    if (signal.aborted) return { status: "cancelled" };
    const installed = await provisioner.ensure(catalogId, { signal });
    if (!installed.available) {
      return normalizeAvailabilityDetail({
        status: mapProvisioningResult(installed),
        catalogId,
        message: installed.message,
      });
    }
    if (signal.aborted) return { status: "cancelled" };
    const connected = await manager.getOrStart({
      projectRoot: rootPath,
      catalogId,
      executablePath: installed.installation.executablePath,
    });
    if (connected.status !== "ok") {
      return { status: mapManagerReason(connected.reason), catalogId };
    }
    return {
      status: "ok",
      server: { catalogId, client: connected.value },
    };
  }

  return {
    async resolveFile(root, path, options) {
      const catalogId = catalogForRootContainedFile(root, path);
      if (!catalogId) return { status: "unconfigured" };
      return resolveCatalog(catalogId, options);
    },
    async resolveWorkspace(_root, options) {
      const resolutions = await Promise.all(
        LSP_CATALOG_IDS.map((catalogId) => resolveCatalog(catalogId, options)),
      );
      return resolutions.map((resolution) =>
        resolution.status === "ok" &&
        !resolution.server.client.supportsWorkspaceDiagnostics
          ? {
              status: "unsupported" as const,
              catalogId: resolution.server.catalogId,
            }
          : resolution,
      );
    },
  };
}

function ensuredCatalogs(settings: LspInspectionSettings): LspCatalogId[] {
  return LSP_CATALOG_IDS.filter(
    (catalogId) => settings.ensureInstalled[catalogId],
  );
}

function catalogForRootContainedFile(
  rootPath: string,
  path: string,
): LspCatalogId | undefined {
  if (!isAbsolute(rootPath)) return undefined;
  const absolutePath = resolve(rootPath, path);
  const fromRoot = relative(resolve(rootPath), absolutePath);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return undefined;
  return findLspCatalogForFile(absolutePath)?.id;
}

function mapProvisioningResult(
  result: Extract<LspProvisioningResult, { available: false }>,
): LspInspectionResolution["status"] {
  switch (result.reason) {
    case "cancelled":
      return "cancelled";
    case "offline":
      return "offline";
    case "probe-failed":
      return "broken";
    default:
      return "unavailable";
  }
}

function mapManagerReason(
  reason: Exclude<
    Awaited<ReturnType<LspServerManagerRuntime["getOrStart"]>>,
    { status: "ok" }
  >["reason"],
): LspInspectionResolution["status"] {
  return reason === "closed" ? "unavailable" : reason;
}

function combinedSignal(
  sessionSignal: AbortSignal,
  requestSignal: AbortSignal | undefined,
): AbortSignal {
  if (!requestSignal || requestSignal === sessionSignal) return sessionSignal;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([sessionSignal, requestSignal]);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  sessionSignal.addEventListener("abort", abort, { once: true });
  requestSignal.addEventListener("abort", abort, { once: true });
  if (sessionSignal.aborted || requestSignal.aborted) controller.abort();
  return controller.signal;
}

export default function (pi: ExtensionAPI): void {
  createLspInspectionExtension(pi);
}
