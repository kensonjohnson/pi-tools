import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EffectiveSettings } from "../../lib/pi-tools-config.ts";
import {
  MAX_LSP_AVAILABILITY_MESSAGE_BYTES,
  type LspDiagnosticsClient,
} from "./inspect.ts";
import {
  createLspInspectionExtension,
  createManagedInspectionResolver,
  type LspProvisioner,
  type LspServerManagerRuntime,
} from "./index.ts";
import type { LspProvisioningResult } from "./provisioner.ts";
import { LSP_INSPECTION_SETTINGS } from "./settings.ts";

class Deferred<T> {
  promise: Promise<T>;
  #resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.#resolve = resolve;
    });
  }

  resolve(value: T): void {
    this.#resolve(value);
  }
}

function runtimeSettings(values: Record<string, unknown>): EffectiveSettings {
  return {
    values: { "lsp-inspection": values },
    sources: {},
    diagnostics: [],
    paths: {
      global: "/global/pi-tools.json",
      project: "/project/pi-tools.json",
    },
    projectTrusted: true,
  };
}

function available(
  catalogId: "typescript" | "go" | "python",
): LspProvisioningResult {
  return {
    available: true,
    source: "installed",
    installation: {
      catalogId,
      version: "test-version",
      executablePath: `/managed/${catalogId}`,
      installedAtMs: 0,
      source: {
        kind: catalogId === "go" ? "go" : "npm",
        version: "test-version",
      },
      health: { checkedAtMs: 0, version: "test-version" },
    },
  };
}

function diagnosticClient(workspace = true): LspDiagnosticsClient {
  return {
    supportsDocumentDiagnostics: true,
    supportsWorkspaceDiagnostics: workspace,
    getDiagnostics: () => [],
    async documentDiagnostics() {
      return { status: "ok", value: { kind: "full", items: [] } };
    },
    async workspaceDiagnostics() {
      return { status: "ok", value: { items: [] } };
    },
  };
}

function createPi() {
  const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
  const tools = new Map<
    string,
    { execute: (...args: any[]) => Promise<any> }
  >();
  const events = new Map<string, (event: unknown) => void>();
  const definitions: unknown[] = [];
  let active = ["read", "other_tool"];
  let actionMethodsAllowed = false;
  const assertActionMethodsAllowed = () => {
    assert.equal(
      actionMethodsAllowed,
      true,
      "action methods must not run while an extension factory is loading",
    );
  };
  const pi = {
    events: {
      emit(channel: string, data: unknown) {
        if (channel === "pi-tools:settings-definition") definitions.push(data);
      },
      on(channel: string, handler: (event: unknown) => void) {
        events.set(channel, handler);
        return () => {};
      },
    },
    on(name: string, handler: (event: unknown, ctx: any) => unknown) {
      handlers.set(name, handler);
    },
    registerTool(tool: {
      name: string;
      execute: (...args: any[]) => Promise<any>;
    }) {
      tools.set(tool.name, tool);
      active.push(tool.name);
    },
    getActiveTools() {
      assertActionMethodsAllowed();
      return active;
    },
    setActiveTools(names: string[]) {
      assertActionMethodsAllowed();
      active = names;
    },
  };
  return {
    pi: pi as unknown as ExtensionAPI,
    handlers,
    tools,
    events,
    definitions,
    enableActionMethods() {
      actionMethodsAllowed = true;
    },
    active: () => active,
  };
}

test("lsp lifecycle publishes settings and trust-gates settings, private state, provisioning, and its active tool", async () => {
  const fixture = createPi();
  let settingsCalls = 0;
  let pathsCalls = 0;
  let provisionerCalls = 0;
  let managerCalls = 0;
  createLspInspectionExtension(fixture.pi, {
    async loadSettings() {
      settingsCalls += 1;
      return runtimeSettings({ enabled: false });
    },
    resolvePaths() {
      pathsCalls += 1;
      return {
        root: "/managed",
        installations: "/managed/servers",
        inventory: "/managed/inventory.json",
      };
    },
    createProvisioner() {
      provisionerCalls += 1;
      throw new Error("must not create provisioner");
    },
    createManager() {
      managerCalls += 1;
      throw new Error("must not create manager");
    },
  });

  fixture.events.get("pi-tools:settings-definition-request")?.({});
  assert.deepEqual(fixture.definitions, [LSP_INSPECTION_SETTINGS]);
  fixture.enableActionMethods();
  // Registration is permitted during factory loading and Pi activates it by
  // default; the session lifecycle removes it before evaluating trust.
  assert.deepEqual(fixture.active(), ["read", "other_tool", "lsp_inspect"]);
  assert.deepEqual([...fixture.tools.keys()], ["lsp_inspect"]);

  await fixture.handlers.get("session_start")?.(
    {},
    {
      cwd: "/untrusted-project",
      isProjectTrusted: () => false,
    },
  );
  assert.equal(settingsCalls, 0);
  assert.equal(pathsCalls, 0);
  assert.equal(provisionerCalls, 0);
  assert.equal(managerCalls, 0);
  assert.deepEqual(fixture.active(), ["read", "other_tool"]);
  const unavailable = await fixture.tools
    .get("lsp_inspect")!
    .execute("", { mode: "workspace" }, undefined, undefined, {
      isProjectTrusted: () => false,
    });
  assert.match(unavailable.content[0].text, /unconfigured/);

  await fixture.handlers.get("session_start")?.(
    {},
    {
      cwd: "/trusted-disabled-project",
      isProjectTrusted: () => true,
    },
  );
  assert.equal(settingsCalls, 1);
  assert.equal(pathsCalls, 0);
  assert.equal(provisionerCalls, 0);
  assert.equal(managerCalls, 0);
  assert.deepEqual(fixture.active(), ["read", "other_tool"]);
});

test("trusted enabled lifecycle starts ensured servers without waiting and shares the provisioner with lsp_inspect", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-lsp-lifecycle-"));
  const fixture = createPi();
  const pending = new Deferred<LspProvisioningResult>();
  const ensurePromises: Promise<LspProvisioningResult>[] = [];
  const managerRequests: unknown[] = [];
  let closed = 0;
  const provisioner: LspProvisioner = {
    ensure(catalogId) {
      assert.equal(catalogId, "typescript");
      ensurePromises.push(pending.promise);
      return pending.promise;
    },
  };
  const manager: LspServerManagerRuntime = {
    async getOrStart(request) {
      managerRequests.push(request);
      return { status: "ok", value: diagnosticClient() as any };
    },
    async close() {
      closed += 1;
    },
  };

  try {
    await writeFile(join(root, "source.ts"), "const current = 1;\n");
    createLspInspectionExtension(fixture.pi, {
      async loadSettings() {
        return runtimeSettings({
          enabled: true,
          ensureInstalled: { typescript: true },
        });
      },
      resolvePaths: () => ({
        root: "/managed",
        installations: "/managed/servers",
        inventory: "/managed/inventory.json",
      }),
      createProvisioner: () => provisioner,
      createManager: () => manager,
    });
    fixture.enableActionMethods();

    await fixture.handlers.get("session_start")?.(
      {},
      {
        cwd: root,
        isProjectTrusted: () => true,
      },
    );
    assert.deepEqual(fixture.active(), ["read", "other_tool", "lsp_inspect"]);
    assert.equal(ensurePromises.length, 1);

    const inspection = fixture.tools
      .get("lsp_inspect")!
      .execute("", { mode: "file", path: "source.ts" }, undefined, undefined, {
        isProjectTrusted: () => true,
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(ensurePromises.length, 2);
    assert.strictEqual(ensurePromises[0], ensurePromises[1]);
    assert.equal(managerRequests.length, 0);

    pending.resolve(available("typescript"));
    const result = await inspection;
    assert.match(result.content[0].text, /Clean: no diagnostics returned/);
    assert.deepEqual(managerRequests, [
      {
        projectRoot: root,
        catalogId: "typescript",
        executablePath: "/managed/typescript",
      },
    ]);

    await fixture.handlers.get("session_shutdown")?.({}, {});
    assert.equal(closed, 1);
    assert.deepEqual(fixture.active(), ["read", "other_tool"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed resolution exposes a bounded typed provisioning failure with catalog identity", async () => {
  const failure = "Pinned package integrity validation failed. ".repeat(30);
  const resolver = createManagedInspectionResolver(
    "/trusted-project",
    {
      async ensure() {
        return {
          available: false,
          reason: "integrity-failed",
          message: failure,
        };
      },
    },
    {
      async getOrStart() {
        throw new Error("an unavailable installation must not start a server");
      },
      async close() {},
    },
    new AbortController().signal,
  );

  const resolved = await resolver.resolveFile(
    "/trusted-project",
    "src/example.ts",
  );
  assert.deepEqual(resolved.status, "unavailable");
  if (resolved.status === "ok") assert.fail("expected an unavailable server");
  assert.equal(resolved.catalogId, "typescript");
  assert.match(
    resolved.message ?? "",
    /^Pinned package integrity validation failed\./,
  );
  assert.ok(
    Buffer.byteLength(resolved.message ?? "", "utf8") <=
      MAX_LSP_AVAILABILITY_MESSAGE_BYTES,
  );
});

test("shutdown invalidates the runtime before aborting installs and late completion cannot revive it", async () => {
  const fixture = createPi();
  const pending = new Deferred<LspProvisioningResult>();
  let installationSignal: AbortSignal | undefined;
  let closeCalls = 0;
  const provisioner: LspProvisioner = {
    ensure(_catalogId, options) {
      installationSignal = options?.signal;
      return pending.promise;
    },
  };
  const manager: LspServerManagerRuntime = {
    async getOrStart(_request) {
      return { status: "ok", value: diagnosticClient() as any };
    },
    async close() {
      closeCalls += 1;
    },
  };
  createLspInspectionExtension(fixture.pi, {
    async loadSettings() {
      return runtimeSettings({
        enabled: true,
        ensureInstalled: { typescript: true },
      });
    },
    resolvePaths: () => ({
      root: "/managed",
      installations: "/managed/servers",
      inventory: "/managed/inventory.json",
    }),
    createProvisioner: () => provisioner,
    createManager: () => manager,
  });
  fixture.enableActionMethods();

  await fixture.handlers.get("session_start")?.(
    {},
    {
      cwd: "/trusted-project",
      isProjectTrusted: () => true,
    },
  );
  assert.deepEqual(fixture.active(), ["read", "other_tool", "lsp_inspect"]);
  await fixture.handlers.get("session_shutdown")?.({}, {});
  assert.equal(installationSignal?.aborted, true);
  assert.equal(closeCalls, 1);
  assert.deepEqual(fixture.active(), ["read", "other_tool"]);

  pending.resolve(available("typescript"));
  await Promise.resolve();
  const afterShutdown = await fixture.tools
    .get("lsp_inspect")!
    .execute("", { mode: "workspace" }, undefined, undefined, {
      isProjectTrusted: () => true,
    });
  assert.match(afterShutdown.content[0].text, /unconfigured/);
});
