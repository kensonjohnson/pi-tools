import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { Diagnostic } from "vscode-languageserver-protocol/node";
import {
  LspDiagnosticInspector,
  MAX_LSP_AVAILABILITY_MESSAGE_BYTES,
  type LspDiagnosticRecord,
  type LspDiagnosticsClient,
  type LspInspectionResolver,
  type LspInspectionResult,
} from "./inspect.ts";
import { renderLspDiagnostics } from "./render.ts";
import {
  LspInspectParameters,
  registerLspInspectTool,
  type LspInspectToolRuntime,
} from "./tool.ts";

const root = "/project";
const uri = "file:///project/src/example.ts";

function diagnostic(severity: 1 | 2 | 3 | 4, message: string): Diagnostic {
  return {
    range: {
      start: { line: severity - 1, character: severity },
      end: { line: severity - 1, character: severity + 1 },
    },
    severity,
    source: " fake\nserver ",
    code: severity,
    message,
  };
}

function client(
  options: {
    document?: readonly Diagnostic[];
    workspace?: readonly { uri: string; diagnostics: readonly Diagnostic[] }[];
    documentReason?: "timeout" | "unsupported";
    workspaceReason?: "timeout" | "unsupported";
  } = {},
): LspDiagnosticsClient {
  return {
    supportsDocumentDiagnostics: !options.documentReason,
    supportsWorkspaceDiagnostics: !options.workspaceReason,
    getDiagnostics: () => [],
    async documentDiagnostics() {
      if (options.documentReason)
        return { status: "unavailable", reason: options.documentReason };
      return {
        status: "ok",
        value: { kind: "full", items: [...(options.document ?? [])] },
      };
    },
    async workspaceDiagnostics() {
      if (options.workspaceReason)
        return { status: "unavailable", reason: options.workspaceReason };
      return {
        status: "ok",
        value: {
          items: (options.workspace ?? []).map((entry) => ({
            kind: "full" as const,
            uri: entry.uri,
            version: null,
            items: [...entry.diagnostics],
          })),
        },
      };
    },
  };
}

function resolver(
  overrides: Partial<LspInspectionResolver> = {},
): LspInspectionResolver {
  const defaultClient = client();
  return {
    async resolveFile() {
      return {
        status: "ok",
        server: { catalogId: "typescript", client: defaultClient },
      };
    },
    async resolveWorkspace() {
      return [
        {
          status: "ok",
          server: { catalogId: "typescript", client: defaultClient },
        },
      ];
    },
    ...overrides,
  };
}

function success(
  status: "ok" | "partial",
  diagnostics: readonly LspDiagnosticRecord[],
): LspInspectionResult {
  return {
    status,
    mode: "workspace",
    diagnostics,
    metadata: {
      freshness: "workspace-pull",
      servers: [
        {
          catalogId: "typescript",
          documentDiagnostics: true,
          workspaceDiagnostics: true,
        },
      ],
    },
    unavailable: status === "partial" ? ["unsupported"] : [],
  };
}

test("lsp_inspect uses strict mutually exclusive file and workspace request schemas", () => {
  const check = TypeCompiler.Compile(LspInspectParameters);
  assert.equal(check.Check({ mode: "file", path: "src/example.ts" }), true);
  assert.equal(
    check.Check({ mode: "file", path: "src/example.ts", contents: "let x" }),
    false,
  );
  assert.equal(check.Check({ mode: "file", path: "../secret.ts" }), false);
  assert.equal(check.Check({ mode: "file", path: "/secret.ts" }), false);
  assert.equal(check.Check({ mode: "file", path: "src\\secret.ts" }), false);
  assert.equal(check.Check({ mode: "workspace" }), true);
  assert.equal(
    check.Check({ mode: "workspace", path: "src/example.ts" }),
    false,
  );
});

test("inspector advances current-content versions and renderer preserves every severity deterministically", async () => {
  const documents: Array<{ uri: string; version: number; text: string }> = [];
  const fakeClient = client({
    document: [
      diagnostic(4, "hint"),
      diagnostic(3, "information"),
      diagnostic(2, "warning"),
      diagnostic(1, "error"),
    ],
  });
  const original = fakeClient.documentDiagnostics.bind(fakeClient);
  fakeClient.documentDiagnostics = async (document, options) => {
    documents.push(document);
    return original(document, options);
  };
  const inspector = new LspDiagnosticInspector(
    resolver({
      async resolveFile() {
        return {
          status: "ok",
          server: { catalogId: "typescript", client: fakeClient },
        };
      },
    }),
  );
  const first = await inspector.inspect(root, {
    mode: "file",
    path: "src/example.ts",
    contents: "const one = 1;",
  });
  await inspector.inspect(root, {
    mode: "file",
    path: "src/example.ts",
    contents: "const two = 2;",
  });
  assert.deepEqual(
    documents.map(({ version, text }) => ({ version, text })),
    [
      { version: 1, text: "const one = 1;" },
      { version: 2, text: "const two = 2;" },
    ],
  );

  const rendered = renderLspDiagnostics(first, {
    rootPath: root,
    maxCount: 10,
    maxBytes: 4_096,
  });
  assert.deepEqual(
    rendered.details.diagnostics.map((entry) => entry.severity),
    ["error", "warning", "information", "hint"],
  );
  assert.equal(rendered.details.diagnostics[0]!.path, "src/example.ts");
  assert.deepEqual(rendered.details.diagnostics[0]!.range.start, {
    line: 1,
    character: 2,
  });
  assert.match(rendered.text, /uri=file:\/\/\/project\/src\/example\.ts/);
  assert.match(rendered.text, /source=fake server code=1/);
});

test("renderer groups and bounds diagnostics with explicit deterministic omissions", () => {
  const diagnostics = Array.from({ length: 8 }, (_, index) => ({
    uri: `file:///project/${index % 2 ? "b" : "a"}.ts`,
    catalogId: "typescript" as const,
    diagnostic: diagnostic(
      ((index % 4) + 1) as 1 | 2 | 3 | 4,
      `message ${index}`,
    ),
  }));
  const result = success("ok", diagnostics);
  const options = { rootPath: root, maxCount: 3, maxBytes: 1_024 };
  const first = renderLspDiagnostics(result, options);
  const second = renderLspDiagnostics(result, options);
  assert.equal(first.text, second.text);
  assert.equal(first.details.diagnostics.length, 3);
  assert.equal(first.details.omitted, 5);
  assert.match(first.text, /Omitted: 5 diagnostics/);
  assert.ok(Buffer.byteLength(first.text, "utf8") <= options.maxBytes);
  assert.match(first.text, /^LSP diagnostics/);
});

test("workspace results are partial when a server is unavailable and unsupported when none respond", async () => {
  const available = client({
    workspace: [{ uri, diagnostics: [diagnostic(2, "workspace warning")] }],
  });
  const partialInspector = new LspDiagnosticInspector(
    resolver({
      async resolveWorkspace() {
        return [
          {
            status: "ok",
            server: { catalogId: "typescript", client: available },
          },
          { status: "unsupported" },
        ];
      },
    }),
  );
  const partial = await partialInspector.inspect(root, { mode: "workspace" });
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.unavailable, ["unsupported"]);
  assert.equal(partial.diagnostics.length, 1);
  assert.doesNotMatch(
    renderLspDiagnostics(partial, {
      rootPath: root,
      maxCount: 10,
      maxBytes: 4_096,
    }).text,
    /Clean: no diagnostics returned/,
  );
  assert.match(
    renderLspDiagnostics(success("partial", []), {
      rootPath: root,
      maxCount: 10,
      maxBytes: 4_096,
    }).text,
    /Partial: unsupported server result is unavailable/,
  );

  const unsupportedInspector = new LspDiagnosticInspector(
    resolver({
      async resolveWorkspace() {
        return [{ status: "unsupported" }];
      },
    }),
  );
  const unsupported = await unsupportedInspector.inspect(root, {
    mode: "workspace",
  });
  assert.equal(unsupported.status, "unsupported");
});

test("availability details preserve catalog-specific provisioning failures for file and partial workspace reports", async () => {
  const repeatedFailure =
    "npm install could not reach the reviewed registry. ".repeat(30);
  const fileInspector = new LspDiagnosticInspector(
    resolver({
      async resolveFile() {
        return {
          status: "offline",
          catalogId: "typescript",
          message: repeatedFailure,
        };
      },
    }),
  );
  const file = await fileInspector.inspect(root, {
    mode: "file",
    path: "src/example.ts",
    contents: "const example = true;",
  });
  const fileRendered = renderLspDiagnostics(file, {
    rootPath: root,
    maxCount: 10,
    maxBytes: 4_096,
  });
  assert.match(
    fileRendered.text,
    /Availability: typescript \(offline\): npm install could not reach the reviewed registry\./,
  );
  assert.equal(fileRendered.details.availability[0]?.catalogId, "typescript");
  assert.equal(fileRendered.details.availability[0]?.status, "offline");
  assert.ok(
    Buffer.byteLength(
      fileRendered.details.availability[0]?.message ?? "",
      "utf8",
    ) <= MAX_LSP_AVAILABILITY_MESSAGE_BYTES,
  );

  const available = client({ workspace: [] });
  const partialInspector = new LspDiagnosticInspector(
    resolver({
      async resolveWorkspace() {
        return [
          {
            status: "ok",
            server: { catalogId: "typescript", client: available },
          },
          {
            status: "unavailable",
            catalogId: "python",
            message: "Pinned pyright installation failed integrity validation.",
          },
        ];
      },
    }),
  );
  const partial = await partialInspector.inspect(root, { mode: "workspace" });
  const partialRendered = renderLspDiagnostics(partial, {
    rootPath: root,
    maxCount: 10,
    maxBytes: 4_096,
  });
  assert.equal(partial.status, "partial");
  assert.match(
    partialRendered.text,
    /Availability: python \(unavailable\): Pinned pyright installation failed integrity validation\./,
  );
  assert.deepEqual(partialRendered.details.availability, [
    {
      status: "unavailable",
      catalogId: "python",
      message: "Pinned pyright installation failed integrity validation.",
    },
  ]);
});

test("availability states never render as a clean report", () => {
  for (const status of [
    "unconfigured",
    "installing",
    "offline",
    "unavailable",
    "broken",
    "timeout",
    "unsupported",
  ] as const) {
    const rendered = renderLspDiagnostics(
      {
        status,
        mode: "file",
        diagnostics: [],
        metadata: { freshness: "current-contents", servers: [] },
        unavailable: [status],
      },
      { rootPath: root, maxCount: 10, maxBytes: 4_096 },
    );
    assert.match(rendered.text, new RegExp(`: ${status};`));
    assert.doesNotMatch(rendered.text, /Clean: no diagnostics returned/);
  }
});

test("registered tool reads root-contained current file contents before inspection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tools-lsp-inspect-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-tools-lsp-outside-"));
  const tools = new Map<
    string,
    { execute: (...args: any[]) => Promise<any> }
  >();
  const requests: LspInspectionRequest[] = [];
  try {
    await writeFile(join(directory, "source.ts"), "const current = 1;\n");
    const runtime: LspInspectToolRuntime = {
      rootPath: directory,
      service: {
        async inspect(_rootPath, request) {
          requests.push(request);
          return success("ok", []);
        },
      },
      diagnostics: { maxCount: 10, maxBytes: 4_096 },
      workspace: { maxCount: 10, maxBytes: 4_096 },
    };
    registerLspInspectTool(
      {
        registerTool(definition: {
          name: string;
          execute: (...args: any[]) => Promise<any>;
        }) {
          tools.set(definition.name, definition);
        },
      } as unknown as ExtensionAPI,
      () => runtime,
    );
    const context = { isProjectTrusted: () => true };
    const result = await tools
      .get("lsp_inspect")!
      .execute(
        "",
        { mode: "file", path: "source.ts" },
        undefined,
        undefined,
        context,
      );
    assert.match(result.content[0].text, /Clean: no diagnostics returned/);
    assert.deepEqual(requests, [
      { mode: "file", path: "source.ts", contents: "const current = 1;\n" },
    ]);

    const missing = await tools
      .get("lsp_inspect")!
      .execute(
        "",
        { mode: "file", path: "missing.ts" },
        undefined,
        undefined,
        context,
      );
    assert.match(missing.content[0].text, /could not be read/);
    assert.doesNotMatch(
      missing.content[0].text,
      /Clean: no diagnostics returned/,
    );

    const secret = join(outside, "secret.ts");
    await writeFile(secret, "const secret = true;\n");
    await symlink(secret, join(directory, "outside.ts"));
    const escaped = await tools
      .get("lsp_inspect")!
      .execute(
        "",
        { mode: "file", path: "outside.ts" },
        undefined,
        undefined,
        context,
      );
    assert.match(escaped.content[0].text, /could not be read/);
    assert.equal(requests.length, 1);
  } finally {
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("registered tool has no diagnostic injection hooks and returns explicit unconfigured state", async () => {
  const tools = new Map<
    string,
    { execute: (...args: any[]) => Promise<any> }
  >();
  registerLspInspectTool(
    {
      registerTool(definition: {
        name: string;
        execute: (...args: any[]) => Promise<any>;
      }) {
        tools.set(definition.name, definition);
      },
    } as unknown as ExtensionAPI,
    () => undefined,
  );
  assert.deepEqual([...tools.keys()], ["lsp_inspect"]);
  const result = await tools
    .get("lsp_inspect")!
    .execute("", { mode: "workspace" }, undefined, undefined, {
      isProjectTrusted: () => true,
    });
  assert.match(result.content[0].text, /unconfigured/);
  assert.doesNotMatch(result.content[0].text, /Clean: no diagnostics returned/);

  const runtime: LspInspectToolRuntime = {
    rootPath: root,
    service: new LspDiagnosticInspector(resolver()),
    diagnostics: { maxCount: 10, maxBytes: 4_096 },
    workspace: { maxCount: 10, maxBytes: 4_096 },
  };
  assert.equal(runtime.rootPath, root);
});
