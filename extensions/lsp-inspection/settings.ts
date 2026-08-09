import type { ExtensionSettingsDefinition } from "../../lib/pi-tools-config.ts";

export const LSP_INSPECTION_EXTENSION_ID = "lsp-inspection";
export const LSP_INSPECTION_TOOL_NAMES = ["lsp_inspect"] as const;

export type LspInspectionSettings = {
  enabled: boolean;
  ensureInstalled: {
    typescript: boolean;
    go: boolean;
    python: boolean;
  };
  diagnostics: {
    maxCount: number;
    maxBytes: number;
  };
  workspace: {
    maxCount: number;
    maxBytes: number;
  };
};

/** Settings intentionally expose no server path, URL, command, or catalog input. */
export const LSP_INSPECTION_SETTINGS: ExtensionSettingsDefinition = {
  id: LSP_INSPECTION_EXTENSION_ID,
  label: "LSP Inspection",
  description:
    "On-demand diagnostics from managed TypeScript, Go, and Python language servers in trusted projects.",
  fields: {
    enabled: {
      type: "boolean",
      default: true,
      label: "Enabled",
      description:
        "Allows trusted projects to expose on-demand LSP diagnostics.",
    },
    "ensureInstalled.typescript": {
      type: "boolean",
      default: false,
      label: "Pre-install TypeScript server",
      description:
        "Provision the reviewed TypeScript server when a trusted session starts.",
    },
    "ensureInstalled.go": {
      type: "boolean",
      default: false,
      label: "Pre-install Go server",
      description:
        "Provision the reviewed Go server when a trusted session starts.",
    },
    "ensureInstalled.python": {
      type: "boolean",
      default: false,
      label: "Pre-install Python server",
      description:
        "Provision the reviewed Python server when a trusted session starts.",
    },
    "diagnostics.maxCount": {
      type: "number",
      default: 100,
      minimum: 1,
      maximum: 1_000,
      integer: true,
      label: "File diagnostic limit",
    },
    "diagnostics.maxBytes": {
      type: "number",
      default: 16 * 1024,
      minimum: 1_024,
      maximum: 256 * 1024,
      integer: true,
      label: "File diagnostic byte limit",
    },
    "workspace.maxCount": {
      type: "number",
      default: 500,
      minimum: 1,
      maximum: 5_000,
      integer: true,
      label: "Workspace diagnostic limit",
    },
    "workspace.maxBytes": {
      type: "number",
      default: 64 * 1024,
      minimum: 1_024,
      maximum: 512 * 1024,
      integer: true,
      label: "Workspace diagnostic byte limit",
    },
  },
  toolNames: LSP_INSPECTION_TOOL_NAMES,
};

export function resolveLspInspectionSettings(
  value: unknown,
): LspInspectionSettings {
  const values = isRecord(value) ? value : {};
  const ensureInstalled = recordAt(values, "ensureInstalled");
  const diagnostics = recordAt(values, "diagnostics");
  const workspace = recordAt(values, "workspace");

  return {
    enabled: booleanAt(values, "enabled", true),
    ensureInstalled: {
      typescript: booleanAt(ensureInstalled, "typescript", false),
      go: booleanAt(ensureInstalled, "go", false),
      python: booleanAt(ensureInstalled, "python", false),
    },
    diagnostics: {
      maxCount: boundedIntegerAt(diagnostics, "maxCount", 100, 1, 1_000),
      maxBytes: boundedIntegerAt(
        diagnostics,
        "maxBytes",
        16 * 1024,
        1_024,
        256 * 1024,
      ),
    },
    workspace: {
      maxCount: boundedIntegerAt(workspace, "maxCount", 500, 1, 5_000),
      maxBytes: boundedIntegerAt(
        workspace,
        "maxBytes",
        64 * 1024,
        1_024,
        512 * 1024,
      ),
    },
  };
}

function recordAt(value: Record<string, unknown>, field: string) {
  const candidate = value[field];
  return isRecord(candidate) ? candidate : {};
}

function booleanAt(
  value: Record<string, unknown>,
  field: string,
  fallback: boolean,
): boolean {
  return typeof value[field] === "boolean" ? value[field] : fallback;
}

function boundedIntegerAt(
  value: Record<string, unknown>,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value[field];
  return typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate >= minimum &&
    candidate <= maximum
    ? candidate
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
