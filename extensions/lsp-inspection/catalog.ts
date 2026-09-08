import { extname } from "node:path";

export const LSP_CATALOG_IDS = ["typescript", "go", "python"] as const;
export type LspCatalogId = (typeof LSP_CATALOG_IDS)[number];

export type NpmServerSource = {
  kind: "npm";
  packages: readonly { name: string; version: string }[];
};

export type GoServerSource = {
  kind: "go";
  module: "golang.org/x/tools/gopls";
  version: string;
};

export type LspServerSource = NpmServerSource | GoServerSource;

export type LspCatalogDescriptor = {
  id: LspCatalogId;
  language: "TypeScript" | "Go" | "Python";
  fileExtensions: readonly string[];
  version: string;
  source: LspServerSource;
  executable: {
    relativePath: string;
    arguments: readonly string[];
  };
  healthProbe: {
    /** Immutable catalog-relative executable used only for version probing. */
    executableRelativePath: string;
    arguments: readonly string[];
    expectedVersion: string;
  };
};

// Review evidence: https://www.npmjs.com/package/typescript-language-server/v/5.3.0
// The server needs TypeScript beside it; its package is pinned separately.
const TYPESCRIPT_DESCRIPTOR: LspCatalogDescriptor = {
  id: "typescript",
  language: "TypeScript",
  fileExtensions: [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
  ],
  version: "5.3.0",
  source: {
    kind: "npm",
    packages: [
      { name: "typescript-language-server", version: "5.3.0" },
      { name: "typescript", version: "5.9.3" },
    ],
  },
  executable: {
    relativePath: "node_modules/.bin/typescript-language-server",
    arguments: ["--stdio"],
  },
  healthProbe: {
    executableRelativePath: "node_modules/.bin/typescript-language-server",
    arguments: ["--version"],
    expectedVersion: "5.3.0",
  },
};

// Review evidence: https://pkg.go.dev/golang.org/x/tools/gopls@v0.23.0
const GO_DESCRIPTOR: LspCatalogDescriptor = {
  id: "go",
  language: "Go",
  fileExtensions: [".go"],
  version: "v0.23.0",
  source: {
    kind: "go",
    module: "golang.org/x/tools/gopls",
    version: "v0.23.0",
  },
  executable: { relativePath: "bin/gopls", arguments: ["serve"] },
  healthProbe: {
    executableRelativePath: "bin/gopls",
    arguments: ["version"],
    expectedVersion: "v0.23.0",
  },
};

// Review evidence: https://www.npmjs.com/package/pyright/v/1.1.411
const PYTHON_DESCRIPTOR: LspCatalogDescriptor = {
  id: "python",
  language: "Python",
  fileExtensions: [".py", ".pyi"],
  version: "1.1.411",
  source: {
    kind: "npm",
    packages: [{ name: "pyright", version: "1.1.411" }],
  },
  executable: {
    relativePath: "node_modules/.bin/pyright-langserver",
    arguments: ["--stdio"],
  },
  healthProbe: {
    executableRelativePath: "node_modules/.bin/pyright",
    arguments: ["--version"],
    expectedVersion: "1.1.411",
  },
};

/**
 * This is deliberately an immutable reviewed list, not configuration input.
 * Adding a language requires a source change and review.
 */
export const LSP_SERVER_CATALOG: readonly LspCatalogDescriptor[] = deepFreeze([
  TYPESCRIPT_DESCRIPTOR,
  GO_DESCRIPTOR,
  PYTHON_DESCRIPTOR,
]);

export function isLspCatalogId(value: unknown): value is LspCatalogId {
  return (
    typeof value === "string" &&
    (LSP_CATALOG_IDS as readonly string[]).includes(value)
  );
}

export function getLspCatalogDescriptor(
  id: LspCatalogId,
): LspCatalogDescriptor {
  const descriptor = LSP_SERVER_CATALOG.find(
    (candidate) => candidate.id === id,
  );
  if (!descriptor) throw new Error(`Unknown managed LSP catalog id '${id}'.`);
  return descriptor;
}

export function findLspCatalogForFile(
  path: string,
): LspCatalogDescriptor | undefined {
  const extension = extname(path).toLowerCase();
  return LSP_SERVER_CATALOG.find((descriptor) =>
    descriptor.fileExtensions.includes(extension),
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
