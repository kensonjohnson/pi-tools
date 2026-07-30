import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getSettingValue,
  publishExtensionSettings,
} from "../../lib/pi-tools-config.ts";
import { getRuntimeSettings } from "../../lib/pi-tools-runtime-settings.ts";
import {
  DEFAULT_ELIGIBLE_TOOLS,
  DEFAULT_MODE,
  DEFAULT_PROFILE_MODE,
  ObservationTracker,
  buildReuseReference,
  parseEligibleTools,
  resolveCompressionMode,
  resolveProfileMode,
  reusableSavingsBytes,
  TOOL_OUTPUT_COMPRESSION_ID,
  type ClassifiedTextResult,
  type CompressionMode,
  type CompressionSettings,
} from "./core.ts";
import {
  createDashboardComponent,
  formatDashboard,
  type DashboardData,
} from "./dashboard.ts";
import { OUTPUT_PROFILES } from "./profiles/registry.ts";
import type { OutputProfile } from "./profiles/types.ts";
import { captureBashRawOutput, probeBashRawOutput } from "./raw-capture.ts";
import { RETRIEVE_TOOL_OUTPUT_NAME, registerRetrieveTool } from "./retrieve.ts";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_RETRIEVAL_MAX_BYTES,
  DEFAULT_STORAGE_MAX_BYTES,
  DEFAULT_STORAGE_RETENTION_DAYS,
  ToolOutputStore,
  type StorageSettings,
} from "./store.ts";

const DEFAULT_DATABASE_PATH = join(
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  "tool-output-compression.sqlite",
);
const RETRIEVAL_TOOL_NAMES = [RETRIEVE_TOOL_OUTPUT_NAME] as const;
const PROFILE_REFERENCE_ID_PLACEHOLDER = "0".repeat(36);
const MEBIBYTE = 1_024 * 1_024;
const DEFAULT_STORAGE_MAX_MIB = DEFAULT_STORAGE_MAX_BYTES / MEBIBYTE;
const RAW_OUTPUT_PROBE_BYTES = 8 * 1_024;

const tracker = new ObservationTracker();
let settings: CompressionSettings = {
  enabled: true,
  mode: DEFAULT_MODE,
  eligibleTools: parseEligibleTools(DEFAULT_ELIGIBLE_TOOLS),
  profileModes: {},
};
let storageSettings: StorageSettings = {
  path: DEFAULT_DATABASE_PATH,
  maxBytes: DEFAULT_STORAGE_MAX_BYTES,
  retentionDays: DEFAULT_STORAGE_RETENTION_DAYS,
  maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  retrievalMaxBytes: DEFAULT_RETRIEVAL_MAX_BYTES,
};
let store: ToolOutputStore | undefined;
let nextToolSequence = 0;
const toolSequences = new Map<string, number>();
const reusableReferences = new Map<string, { id: string; sequence: number }>();

async function loadSettings(ctx: ExtensionContext): Promise<void> {
  const runtime = await getRuntimeSettings(ctx, CONFIG_DIR_NAME);
  settings = {
    enabled:
      getSettingValue<boolean>(
        runtime,
        TOOL_OUTPUT_COMPRESSION_ID,
        "enabled",
      ) !== false,
    mode: resolveCompressionMode(
      getSettingValue<string>(runtime, TOOL_OUTPUT_COMPRESSION_ID, "mode"),
    ),
    eligibleTools: parseEligibleTools(
      getSettingValue<string>(
        runtime,
        TOOL_OUTPUT_COMPRESSION_ID,
        "eligibleTools",
      ) ?? DEFAULT_ELIGIBLE_TOOLS,
    ),
    profileModes: Object.fromEntries(
      OUTPUT_PROFILES.map((profile) => [
        profile.id,
        resolveCompressionMode(
          getSettingValue<string>(
            runtime,
            TOOL_OUTPUT_COMPRESSION_ID,
            `profiles.${profile.settingPath}.mode`,
          ) ?? DEFAULT_PROFILE_MODE,
        ),
      ]),
    ),
  };
  storageSettings = {
    path: resolveStoragePath(
      getSettingValue<string>(
        runtime,
        TOOL_OUTPUT_COMPRESSION_ID,
        "storage.path",
      ) ?? DEFAULT_DATABASE_PATH,
    ),
    maxBytes:
      (getSettingValue<number>(
        runtime,
        TOOL_OUTPUT_COMPRESSION_ID,
        "storage.maxMiB",
      ) ?? DEFAULT_STORAGE_MAX_MIB) * MEBIBYTE,
    retentionDays:
      getSettingValue<number>(
        runtime,
        TOOL_OUTPUT_COMPRESSION_ID,
        "storage.retentionDays",
      ) ?? DEFAULT_STORAGE_RETENTION_DAYS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    retrievalMaxBytes: DEFAULT_RETRIEVAL_MAX_BYTES,
  };
}

function resolveStoragePath(value: string): string {
  const path = value.trim();
  if (!path) return DEFAULT_DATABASE_PATH;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

function getStore(): ToolOutputStore {
  if (store && store.settings.path === storageSettings.path) return store;
  void store?.close();
  store = new ToolOutputStore(storageSettings);
  return store;
}

async function applyExactReuse(
  event: { toolCallId: string; toolName: string },
  ctx: ExtensionContext,
  output: ClassifiedTextResult,
): Promise<{ content: Array<{ type: "text"; text: string }> } | undefined> {
  try {
    const sequence = toolSequences.get(event.toolCallId) ?? nextToolSequence++;
    toolSequences.set(event.toolCallId, sequence);
    const sessionId = ctx.sessionManager.getSessionId();
    const outputStore = getStore();
    let reference = reusableReferences.get(output.contentHash);

    if (!reference) {
      const stored = await outputStore.findReference(
        sessionId,
        output.contentHash,
        ctx.signal,
      );
      if (stored) {
        reference = { id: stored.id, sequence: -1 };
        reusableReferences.set(output.contentHash, reference);
      }
    }

    if (reference && reference.sequence < sequence) {
      const compact = buildReuseReference(reference.id, output.outputBytes);
      const compactBytes = Buffer.byteLength(compact, "utf8");
      if (reusableSavingsBytes(output.outputBytes, compactBytes) > 0) {
        tracker.recordApplied(event.toolName, output.outputBytes, compactBytes);
        return { content: [{ type: "text", text: compact }] };
      }
      return undefined;
    }

    const createdAtMs = Date.now();
    const stored = await outputStore.store(
      {
        sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        contentHash: output.contentHash,
        content: output.content,
        createdAtMs,
        expiresAtMs:
          createdAtMs + storageSettings.retentionDays * 24 * 60 * 60 * 1_000,
      },
      ctx.signal,
    );
    if (!reference || sequence < reference.sequence) {
      reusableReferences.set(output.contentHash, { id: stored.id, sequence });
    }
  } catch {
    // Optional compression must fail open: no durable artifact means no patch.
  }
  return undefined;
}

async function applyProfiles(
  event: { toolCallId: string; toolName: string; details?: unknown },
  ctx: ExtensionContext,
  output: ClassifiedTextResult,
): Promise<{ content: Array<{ type: "text"; text: string }> } | undefined> {
  let candidates = OUTPUT_PROFILES.filter(
    (profile) =>
      profile.toolNames.includes(event.toolName) &&
      resolveProfileMode(settings, profile.id) !== "off" &&
      profile.mayMatch(output.content),
  );

  // Current profiles are bash profiles. Keep full-output recovery owned by the
  // engine so every future bash grammar shares its cancellation/size rules.
  if (event.toolName !== "bash") return undefined;
  try {
    const probeProfiles = OUTPUT_PROFILES.filter(
      (profile) =>
        profile.toolNames.includes(event.toolName) &&
        resolveProfileMode(settings, profile.id) !== "off" &&
        profile.mayMatchRecoveredRaw !== undefined,
    );
    if (probeProfiles.length > 0) {
      const probe = await probeBashRawOutput(
        event.details,
        storageSettings.maxOutputBytes,
        RAW_OUTPUT_PROBE_BYTES,
        ctx.signal,
      );
      if (probe) {
        const recoveredCandidates = probeProfiles.filter((profile) =>
          profile.mayMatchRecoveredRaw!(probe),
        );
        candidates = Array.from(
          new Map(
            [...candidates, ...recoveredCandidates].map((profile) => [
              profile.id,
              profile,
            ]),
          ).values(),
        );
      }
    }
    if (candidates.length === 0) return undefined;

    const raw = await captureBashRawOutput(
      event.details,
      output.content,
      storageSettings.maxOutputBytes,
      ctx.signal,
    );
    for (const profile of candidates) {
      const mode = resolveProfileMode(settings, profile.id);
      const analysis = profile.analyze(raw.content);
      if (!analysis.applicable) {
        tracker.recordProfileBypass(profile.id, analysis.reason);
        continue;
      }

      const renderOptions = {
        visibleBytes: output.outputBytes,
        rawSource: raw.source,
      } as const;
      const compactCandidate = analysis.render(
        PROFILE_REFERENCE_ID_PLACEHOLDER,
        renderOptions,
      );
      const compactBytes = Buffer.byteLength(compactCandidate, "utf8");
      tracker.recordProfileCandidate(profile.id, {
        visibleBytes: output.outputBytes,
        rawBytes: analysis.rawBytes,
        compactBytes,
        summary: analysis.summary,
        recoveredFullOutput: raw.source === "full-output-path",
      });
      if (
        mode !== "apply" ||
        !isSmallerThanVisible(output.content, compactCandidate)
      ) {
        continue;
      }

      const createdAtMs = Date.now();
      const stored = await getStore().store(
        {
          sessionId: ctx.sessionManager.getSessionId(),
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          contentHash: createHash("sha256").update(raw.content).digest("hex"),
          content: raw.content,
          createdAtMs,
          expiresAtMs:
            createdAtMs + storageSettings.retentionDays * 24 * 60 * 60 * 1_000,
          provenance: {
            strategy: profile.id,
            source: raw.source,
            visibleBytes: output.outputBytes,
            compactBytes,
            metadata: JSON.stringify(analysis.summary),
          },
        },
        ctx.signal,
      );
      const compact = analysis.render(stored.id, renderOptions);
      if (!isSmallerThanVisible(output.content, compact)) return undefined;

      tracker.recordProfileApplied(
        profile.id,
        output.outputBytes,
        Buffer.byteLength(compact, "utf8"),
      );
      return { content: [{ type: "text", text: compact }] };
    }
  } catch {
    for (const profile of candidates) {
      tracker.recordProfileBypass(profile.id, "raw-capture-or-storage");
    }
  }
  return undefined;
}

function isSmallerThanVisible(visible: string, compact: string): boolean {
  return (
    Buffer.byteLength(compact, "utf8") < Buffer.byteLength(visible, "utf8")
  );
}

async function dashboardData(): Promise<DashboardData> {
  let storage;
  try {
    storage = await getStore().stats();
  } catch {
    // Reporting must not make observation or retrieval fail when storage is unavailable.
  }
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    eligibleTools: settings.eligibleTools,
    profiles: OUTPUT_PROFILES.map((profile) => ({
      id: profile.id,
      label: profile.label,
      mode: resolveProfileMode(settings, profile.id),
    })),
    metrics: tracker.snapshot(),
    storage,
  };
}

function profileSettingFields() {
  return Object.fromEntries(
    OUTPUT_PROFILES.map((profile) => [
      `profiles.${profile.settingPath}.mode`,
      {
        type: "enum" as const,
        default: DEFAULT_PROFILE_MODE,
        values: ["off", "observe", "apply"],
        label: `${profile.label} profile`,
        description:
          "Observe candidates without persistence; Apply stores raw output before replacing a verified result.",
      },
    ]),
  );
}

export default function (pi: ExtensionAPI) {
  publishExtensionSettings(pi.events, {
    id: TOOL_OUTPUT_COMPRESSION_ID,
    label: "Tool Output Compression",
    description:
      "Observes configured text tool output, exact-reuse opportunities, and registered structured-output profiles.",
    fields: {
      enabled: { type: "boolean", default: true, label: "Enabled" },
      mode: {
        type: "enum",
        default: DEFAULT_MODE,
        values: ["off", "observe", "apply"],
        label: "Mode",
        description:
          "Observe is non-mutating. Apply enables explicitly configured profile replacements and exact reuse.",
      },
      ...profileSettingFields(),
      eligibleTools: {
        type: "string",
        default: DEFAULT_ELIGIBLE_TOOLS,
        label: "Eligible tools",
        description:
          "Comma-separated tool names eligible for exact-reuse and profile analysis.",
      },
      "storage.path": {
        type: "string",
        default: DEFAULT_DATABASE_PATH,
        label: "Database path",
        description:
          "Private SQLite database path for durable raw tool output.",
      },
      "storage.maxMiB": {
        type: "number",
        default: DEFAULT_STORAGE_MAX_MIB,
        minimum: 1,
        maximum: 4_096,
        label: "Raw storage budget (MiB)",
        description:
          "Maximum disk space for retrievable raw output when apply mode stores artifacts.",
      },
      "storage.retentionDays": {
        type: "number",
        default: DEFAULT_STORAGE_RETENTION_DAYS,
        minimum: 1,
        maximum: 3_650,
        label: "Retention (days)",
      },
    },
    toolNames: RETRIEVAL_TOOL_NAMES,
  });

  registerRetrieveTool(pi, getStore);

  pi.on("session_start", async (_event, ctx) => {
    tracker.reset();
    nextToolSequence = 0;
    toolSequences.clear();
    reusableReferences.clear();
    await loadSettings(ctx);
    if (!settings.enabled) {
      pi.setActiveTools(
        pi
          .getActiveTools()
          .filter((toolName) => !RETRIEVAL_TOOL_NAMES.includes(toolName)),
      );
    }
  });

  pi.on("session_shutdown", async () => {
    await store?.close();
    store = undefined;
    toolSequences.clear();
    reusableReferences.clear();
  });

  pi.on("tool_execution_start", (event) => {
    toolSequences.set(event.toolCallId, nextToolSequence++);
  });

  pi.on("tool_result", async (event, ctx) => {
    const output = tracker.observe(event, settings);
    if (!output) return;

    // Begin successful bash full-output recovery before any storage work.
    const profilePatch = await applyProfiles(event, ctx, output);
    if (profilePatch) return profilePatch;
    if (settings.mode !== "apply") return;
    return applyExactReuse(event, ctx, output);
  });

  pi.registerCommand("tool-output", {
    description: "Show and maintain tool-output compression storage",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "prune") {
        const removed = await getStore().prune();
        ctx.ui.notify(
          `Pruned ${removed} expired stored tool output${removed === 1 ? "" : "s"}.`,
          "info",
        );
        return;
      }
      if (action === "vacuum") {
        await getStore().vacuum();
        ctx.ui.notify("Compacted the tool-output SQLite database.", "info");
        return;
      }
      if (action) {
        ctx.ui.notify("Usage: /tool-output [prune|vacuum]", "warning");
        return;
      }

      const data = await dashboardData();
      if (ctx.mode !== "tui") {
        ctx.ui.notify(formatDashboard(data), "info");
        return;
      }
      await ctx.ui.custom<void>((_tui, theme, _keybindings, done) =>
        createDashboardComponent(data, theme, done),
      );
    },
  });
}
