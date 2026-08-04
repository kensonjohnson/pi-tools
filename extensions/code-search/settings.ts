import type { ExtensionSettingsDefinition } from "../../lib/pi-tools-config.ts";

export const CODE_SEARCH_EXTENSION_ID = "code-search";
export const CODE_SEARCH_TOOL_NAMES = [
  "code_search",
  "code_outline",
  "code_get",
  "code_context",
] as const;

export type CodeSearchMode = "off" | "observe" | "apply";

export function resolveCodeSearchMode(value: unknown): CodeSearchMode {
  return value === "off" || value === "apply" ? value : "observe";
}

export const CODE_SEARCH_SETTINGS: ExtensionSettingsDefinition = {
  id: CODE_SEARCH_EXTENSION_ID,
  label: "Code Search",
  description:
    "Local AST-aware code navigation. In untrusted directories it is always dormant.",
  fields: {
    mode: {
      type: "enum",
      default: "observe",
      values: ["off", "observe", "apply"],
      label: "Mode",
      description:
        "Observe builds only trusted-project local metadata and metrics; Apply exposes code-search tools.",
    },
    "output.style": {
      type: "enum",
      default: "compact",
      values: ["compact", "structured"],
      label: "Discovery output",
    },
    "index.additionalIgnores": {
      type: "string",
      default: "",
      label: "Additional ignored paths",
      description:
        "Comma-separated root-relative hard exclusions, for example docs/**.",
    },
    "index.watch": {
      type: "boolean",
      default: false,
      label: "Watch files",
      description:
        "Optional session-only refresh acceleration; validation on tool use remains required.",
    },
    "search.maxResults": {
      type: "number",
      default: 10,
      minimum: 1,
      maximum: 100,
      label: "Search result limit",
    },
    "search.tokenBudget": {
      type: "number",
      default: 1_200,
      minimum: 128,
      maximum: 8_000,
      label: "Search token budget",
    },
    "retrieval.tokenBudget": {
      type: "number",
      default: 4_000,
      minimum: 256,
      maximum: 16_000,
      label: "Retrieval token budget",
    },
    "context.tokenBudget": {
      type: "number",
      default: 6_000,
      minimum: 256,
      maximum: 16_000,
      label: "Context token budget",
    },
    "metrics.retentionDays": {
      type: "number",
      default: 90,
      minimum: 1,
      maximum: 3_650,
      label: "Global metrics retention (days)",
      description:
        "Applies to extension-wide aggregate metrics in Pi's agent directory; configure at global scope.",
    },
  },
  toolNames: CODE_SEARCH_TOOL_NAMES,
};
