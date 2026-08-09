import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import type {
  LspInspectionRequest,
  LspInspectionResult,
  LspInspectionService,
} from "./inspect.ts";
import { renderLspDiagnostics } from "./render.ts";

const ROOT_RELATIVE_PATH_PATTERN =
  "^(?!/)(?!.*\\\\)(?!.*//)(?!.*(?:^|/)\\.\\.?/)(?!\\.\\.?$)[^\\u0000]+$";
const MAX_FILE_CONTENTS_BYTES = 4 * 1024 * 1024;

export const LspInspectFileParameters = Type.Object(
  {
    mode: Type.Literal("file"),
    path: Type.String({
      minLength: 1,
      maxLength: 1_024,
      pattern: ROOT_RELATIVE_PATH_PATTERN,
      description:
        "Root-relative file path; absolute paths, traversal, and backslashes are rejected.",
    }),
  },
  { additionalProperties: false },
);

export const LspInspectWorkspaceParameters = Type.Object(
  { mode: Type.Literal("workspace") },
  { additionalProperties: false },
);

export const LspInspectParameters = Type.Union(
  [LspInspectFileParameters, LspInspectWorkspaceParameters],
  {
    description:
      "Inspect one current-content root-relative file, or explicitly inspect the whole workspace.",
  },
);

export type LspInspectParameters = Static<typeof LspInspectParameters>;

export type LspInspectToolRuntime = {
  rootPath: string;
  service: LspInspectionService;
  diagnostics: { maxCount: number; maxBytes: number };
  workspace: { maxCount: number; maxBytes: number };
};

export function registerLspInspectTool(
  pi: ExtensionAPI,
  getRuntime: () => LspInspectToolRuntime | undefined,
): void {
  pi.registerTool({
    name: "lsp_inspect",
    label: "LSP Inspect",
    description:
      "Inspect current file contents or explicit workspace diagnostics through reviewed managed language servers.",
    parameters: LspInspectParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const runtime = getRuntime();
      if (!runtime || !ctx.isProjectTrusted()) {
        return toolResult(unconfigured(params.mode), {
          rootPath: runtime?.rootPath ?? process.cwd(),
          maxCount: 0,
          maxBytes: 1_024,
        });
      }
      if (params.mode === "file" && !isRootRelativePath(params.path)) {
        return invalidPathResult(params.path);
      }
      const limits =
        params.mode === "file" ? runtime.diagnostics : runtime.workspace;
      let request: LspInspectionRequest;
      try {
        request =
          params.mode === "file"
            ? {
                mode: "file",
                path: params.path,
                contents: await readRootContainedFile(
                  runtime.rootPath,
                  params.path,
                ),
              }
            : { mode: "workspace" };
      } catch {
        return unreadableFileResult(params.mode === "file" ? params.path : "");
      }
      try {
        const inspected = await runtime.service.inspect(
          runtime.rootPath,
          request,
          { signal },
        );
        return toolResult(inspected, {
          rootPath: runtime.rootPath,
          maxCount: limits.maxCount,
          maxBytes: limits.maxBytes,
        });
      } catch {
        return toolResult(broken(params.mode), {
          rootPath: runtime.rootPath,
          maxCount: limits.maxCount,
          maxBytes: limits.maxBytes,
        });
      }
    },
  });
}

function toolResult(
  result: LspInspectionResult,
  options: { rootPath: string; maxCount: number; maxBytes: number },
) {
  const rendered = renderLspDiagnostics(result, options);
  return {
    content: [
      {
        type: "text" as const,
        text: rendered.text,
      },
    ],
    details: rendered.details,
  };
}

function unreadableFileResult(path: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `LSP diagnostics (file): unavailable; current contents for '${path}' could not be read from the project root.`,
      },
    ],
    details: { status: "unavailable", unreadableFile: true },
    isError: true,
  };
}

function invalidPathResult(path: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `LSP diagnostics (file): unavailable; '${path}' is not a root-relative file path.`,
      },
    ],
    details: { status: "unavailable", invalidPath: true },
    isError: true,
  };
}

function unconfigured(mode: "file" | "workspace"): LspInspectionResult {
  return {
    status: "unconfigured",
    mode,
    diagnostics: [],
    metadata: {
      freshness: mode === "file" ? "current-contents" : "workspace-pull",
      servers: [],
    },
    unavailable: ["unconfigured"],
  };
}

function broken(mode: "file" | "workspace"): LspInspectionResult {
  return {
    ...unconfigured(mode),
    status: "broken",
    unavailable: ["broken"],
  };
}

async function readRootContainedFile(
  rootPath: string,
  path: string,
): Promise<string> {
  const root = await realpath(rootPath);
  const candidate = resolve(root, path);
  if (!isContainedPath(root, candidate)) throw new Error("Path escapes root.");
  // Canonicalize before opening so an in-root symlink cannot point outside the
  // trusted project. O_NOFOLLOW then rejects a final-component swap.
  const filePath = await realpath(candidate);
  if (!isContainedPath(root, filePath)) throw new Error("Path escapes root.");
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await file.stat();
    if (!status.isFile() || status.size > MAX_FILE_CONTENTS_BYTES) {
      throw new Error("Path is not a readable regular file.");
    }
    return await file.readFile({ encoding: "utf8" });
  } finally {
    await file.close();
  }
}

function isRootRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function isContainedPath(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    Boolean(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`)
  );
}
