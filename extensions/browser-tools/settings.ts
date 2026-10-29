import type { ExtensionSettingsDefinition } from "../../lib/pi-tools-config.ts";
import { DIAGNOSTIC_TOOL_NAMES } from "./diagnostics-registration.ts";
import { EXTRACTION_TOOL_NAMES } from "./extraction.ts";

export const BROWSER_SETTINGS_ID = "browser-tools";
export const BROWSER_TOOL_NAMES = [
  "browser_session",
  "browser_attachment",
  "browser_navigate",
  "browser_snapshot",
  "browser_snapshot_ref",
  "browser_action",
  "browser_handoff",
  "browser_upload",
  "browser_dialog",
  "browser_screenshot",
  "browser_viewport",
  "browser_pick",
  "browser_content",
  "browser_eval",
  "browser_artifact",
  "browser_download",
  "browser_recording",
  ...EXTRACTION_TOOL_NAMES,
  ...DIAGNOSTIC_TOOL_NAMES,
] as const;
export const BROWSER_SETTINGS: ExtensionSettingsDefinition = {
  id: BROWSER_SETTINGS_ID,
  label: "Browser tools",
  description:
    "Managed Chromium sessions with semantic snapshots and a visible-tab human picker; picker selections are non-actionable metadata and frame changes cancel selection.",
  fields: {
    enabled: { type: "boolean", default: true, label: "Enabled" },
    diagnosticsEnabled: {
      type: "boolean",
      default: true,
      label: "Collect page diagnostics",
      description:
        "Capture bounded page console and network metadata for managed tabs.",
    },
    diagnosticsMaxEntries: {
      type: "number",
      default: 500,
      minimum: 1,
      maximum: 10000,
      integer: true,
      label: "Diagnostics entries per history",
    },
    diagnosticsMaxBytes: {
      type: "number",
      default: 1048576,
      minimum: 512,
      maximum: 16777216,
      integer: true,
      label: "Diagnostics bytes per history",
    },
    autoInstall: {
      type: "boolean",
      default: true,
      label: "Install missing Chromium",
      description: "Only trusted projects may download Chromium automatically.",
    },
    startupTimeoutMs: {
      type: "number",
      default: 180000,
      minimum: 1000,
      maximum: 600000,
      integer: true,
      label: "Startup deadline (ms)",
    },
    profileWaitTimeoutMs: {
      type: "number",
      default: 30000,
      minimum: 100,
      maximum: 600000,
      integer: true,
      label: "Profile lease wait deadline (ms)",
    },
    navigationTimeoutMs: {
      type: "number",
      default: 30000,
      minimum: 1000,
      maximum: 180000,
      integer: true,
      label: "Navigation deadline (ms)",
    },
    uploadMaxFileBytes: {
      type: "number",
      default: 10000000,
      minimum: 1,
      maximum: 25000000,
      integer: true,
      label: "Upload maximum bytes per file",
    },
    uploadMaxTotalBytes: {
      type: "number",
      default: 25000000,
      minimum: 1,
      maximum: 50000000,
      integer: true,
      label: "Upload maximum bytes per operation",
    },
    screenshotMaxDimension: {
      type: "number",
      default: 8192,
      minimum: 100,
      maximum: 32768,
      integer: true,
      label: "Screenshot maximum dimension (px)",
    },
    screenshotMaxPixels: {
      type: "number",
      default: 16000000,
      minimum: 10000,
      maximum: 32000000,
      integer: true,
      label: "Screenshot maximum pixels",
    },
    screenshotMaxBytes: {
      type: "number",
      default: 12000000,
      minimum: 1024,
      maximum: 12000000,
      integer: true,
      label: "Screenshot maximum PNG bytes",
    },
    screenshotTimeoutMs: {
      type: "number",
      default: 10000,
      minimum: 100,
      maximum: 30000,
      integer: true,
      label: "Screenshot and viewport deadline (ms)",
    },
    artifactQuotaBytes: {
      type: "number",
      default: 268435456,
      minimum: 1024,
      maximum: 1073741824,
      integer: true,
      label: "Managed artifact quota (bytes)",
    },
    artifactTtlMs: {
      type: "number",
      default: 3600000,
      minimum: 1000,
      maximum: 604800000,
      integer: true,
      label: "Managed artifact retention (ms)",
    },
    recordingDurationMs: {
      type: "number",
      default: 300000,
      minimum: 1000,
      maximum: 3600000,
      integer: true,
      label: "Recording deadline (ms)",
      description:
        "Stops traces and closes video-enabled sessions at the deadline; native transient files are not size-capped.",
    },
    shutdownTimeoutMs: {
      type: "number",
      default: 5000,
      minimum: 100,
      maximum: 30000,
      integer: true,
      label: "Shutdown deadline (ms)",
    },
  },
  toolNames: BROWSER_TOOL_NAMES,
};
export type BrowserSettings = {
  enabled: boolean;
  autoInstall: boolean;
  diagnosticsEnabled: boolean;
  diagnosticsMaxEntries: number;
  diagnosticsMaxBytes: number;
  startupTimeoutMs: number;
  profileWaitTimeoutMs: number;
  navigationTimeoutMs: number;
  shutdownTimeoutMs: number;
  recordingDurationMs: number;
  artifactQuotaBytes: number;
  artifactTtlMs: number;
};
export function resolveUploadLimits(input: unknown) {
  const value =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const bounded = (key: string, fallback: number, max: number) =>
    typeof value[key] === "number" &&
    Number.isInteger(value[key]) &&
    (value[key] as number) >= 1 &&
    (value[key] as number) <= max
      ? (value[key] as number)
      : fallback;
  return {
    maxFileBytes: bounded("uploadMaxFileBytes", 10000000, 25000000),
    maxTotalBytes: bounded("uploadMaxTotalBytes", 25000000, 50000000),
  };
}
export function resolveScreenshotLimits(input: unknown) {
  const value =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const number = (key: string, fallback: number, min: number, max: number) =>
    typeof value[key] === "number" &&
    Number.isInteger(value[key]) &&
    (value[key] as number) >= min &&
    (value[key] as number) <= max
      ? (value[key] as number)
      : fallback;
  return {
    maxDimension: number("screenshotMaxDimension", 8192, 100, 32768),
    maxPixels: number("screenshotMaxPixels", 16000000, 10000, 32000000),
    maxBytes: number("screenshotMaxBytes", 12000000, 1024, 12000000),
    timeoutMs: number("screenshotTimeoutMs", 10000, 100, 30000),
  };
}
export function resolveBrowserSettings(input: unknown): BrowserSettings {
  const value =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const flag = (key: string, fallback: boolean) =>
    typeof value[key] === "boolean" ? (value[key] as boolean) : fallback;
  const number = (key: string, fallback: number, min: number, max: number) =>
    typeof value[key] === "number" &&
    Number.isInteger(value[key]) &&
    (value[key] as number) >= min &&
    (value[key] as number) <= max
      ? (value[key] as number)
      : fallback;
  return {
    enabled: flag("enabled", true),
    autoInstall: flag("autoInstall", true),
    diagnosticsEnabled: flag("diagnosticsEnabled", true),
    diagnosticsMaxEntries: number("diagnosticsMaxEntries", 500, 1, 10000),
    diagnosticsMaxBytes: number("diagnosticsMaxBytes", 1048576, 512, 16777216),
    startupTimeoutMs: number("startupTimeoutMs", 180000, 1000, 600000),
    profileWaitTimeoutMs: number("profileWaitTimeoutMs", 30000, 100, 600000),
    navigationTimeoutMs: number("navigationTimeoutMs", 30000, 1000, 180000),
    shutdownTimeoutMs: number("shutdownTimeoutMs", 5000, 100, 30000),
    recordingDurationMs: number("recordingDurationMs", 300000, 1000, 3600000),
    artifactQuotaBytes: number(
      "artifactQuotaBytes",
      268435456,
      1024,
      1073741824,
    ),
    artifactTtlMs: number("artifactTtlMs", 3600000, 1000, 604800000),
  };
}
