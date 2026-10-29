import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { ArtifactStore } from "./artifacts.ts";
import { binaryChunkOutput, chunkOutput, inspectionOutput } from "./output.ts";
import { chromium } from "playwright";
import {
  publishExtensionSettings,
  type EffectiveSettings,
} from "../../lib/pi-tools-config.ts";
import { getRuntimeSettings } from "../../lib/pi-tools-runtime-settings.ts";
import { ChromiumInstaller } from "./installer.ts";
import { ManagedSessions } from "./sessions.ts";
import { DownloadManager } from "./downloads.ts";
import { TraceRecordings } from "./recording.ts";
import { VideoRecordings } from "./video-recording.ts";
import {
  listRecordingRecovery,
  RECORDING_RECOVERY_SCAN_LIMIT,
} from "./recording-recovery.ts";
import { registerExtractionTools } from "./extraction.ts";
import { BrowserDiagnostics } from "./diagnostics.ts";
import {
  DIAGNOSTIC_TOOL_NAMES,
  registerDiagnosticTools,
} from "./diagnostics-registration.ts";
import { formatResult, formatSessionList } from "./results.ts";
import {
  BROWSER_SETTINGS,
  BROWSER_SETTINGS_ID,
  BROWSER_TOOL_NAMES,
  resolveBrowserSettings,
  resolveScreenshotLimits,
  resolveUploadLimits,
} from "./settings.ts";

/** Register the managed browser toolkit for one Pi extension runtime. */
export function createManagedBrowserExtension(
  realPi: ExtensionAPI,
  options: {
    loadSettings?: (ctx: {
      cwd: string;
      isProjectTrusted(): boolean;
    }) => Promise<EffectiveSettings>;
    // Injected factories must pass diagnostics into ManagedSessions.
    createSessions?: (
      diagnostics?: BrowserDiagnostics,
      downloads?: DownloadManager,
      recordings?: TraceRecordings,
      videos?: VideoRecordings,
    ) => ManagedSessions;
    createInstaller?: () => ChromiumInstaller;
    createArtifacts?: (
      settings: ReturnType<typeof resolveBrowserSettings>,
    ) => ArtifactStore;
  } = {},
): void {
  const definitions: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
  const pi = new Proxy(realPi, {
    get(target, key, receiver) {
      if (key === "registerTool")
        return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => {
          definitions.push(definition);
        };
      return Reflect.get(target, key, receiver);
    },
  });
  // Pi reports only the winning definition. Registrations after this startup
  // check follow Pi's extension load-order policy and are not detectable here.
  let registered = false;
  const activated = new Set<string>();
  const definitionFor = (name: string) =>
    definitions.find((definition) => definition.name === name);
  const registeredTools = () =>
    typeof realPi.getAllTools === "function" ? realPi.getAllTools() : undefined;
  const isOwned = (
    name: string,
    tools: ReturnType<ExtensionAPI["getAllTools"]> | undefined,
  ) =>
    !tools ||
    tools.some(
      (tool) =>
        tool.name === name &&
        tool.parameters === definitionFor(name)?.parameters,
    );
  const loadSettings =
    options.loadSettings ?? ((ctx) => getRuntimeSettings(ctx, CONFIG_DIR_NAME));
  let runtime:
    | {
        sessions: ManagedSessions;
        diagnostics?: BrowserDiagnostics;
        installer: ChromiumInstaller;
        controller: AbortController;
        trusted: boolean;
        owner: string;
        artifacts: ArtifactStore;
        downloads: DownloadManager;
        recordings: TraceRecordings;
        videos: VideoRecordings;
        settings: ReturnType<typeof resolveBrowserSettings>;
        screenshotLimits: ReturnType<typeof resolveScreenshotLimits>;
        uploadLimits: ReturnType<typeof resolveUploadLimits>;
      }
    | undefined;
  let version = 0;
  let cleanup: Promise<void> = Promise.resolve();
  const remove = () => {
    if (!activated.size) return;
    const tools = registeredTools();
    pi.setActiveTools(
      pi
        .getActiveTools()
        .filter((name) => !activated.has(name) || !isOwned(name, tools)),
    );
    activated.clear();
  };
  const stop = async () => {
    const current = runtime;
    runtime = undefined;
    remove();
    if (current) {
      current.controller.abort();
      let diagnosticsFailed = false;
      try {
        current.diagnostics?.shutdown();
      } catch {
        diagnosticsFailed = true;
      }
      let shutdown: Promise<{ complete: boolean }>;
      try {
        shutdown = current.sessions.shutdown(
          current.settings.shutdownTimeoutMs,
        );
      } catch (error) {
        shutdown = Promise.reject(error);
      }
      const closing = shutdown.then(
        (result) => {
          if (diagnosticsFailed || !result.complete)
            console.warn(
              "Browser cleanup did not complete or could not be verified; browser processes or other resources may remain.",
            );
        },
        () => {
          console.warn(
            "Browser cleanup did not complete or could not be verified; browser processes or other resources may remain.",
          );
        },
      );
      cleanup = Promise.all([cleanup, closing]).then(() => {});
    }
    await cleanup;
  };
  const requireRuntime = () => {
    if (!runtime)
      throw new Error("Managed browser runtime is disabled or unavailable.");
    return runtime;
  };
  const textResult = (text: string) => ({
    content: [{ type: "text" as const, text }],
    details: undefined,
  });
  const result = (value: unknown) => textResult(formatResult(value));
  publishExtensionSettings(pi.events, BROWSER_SETTINGS);
  registerDiagnosticTools(
    pi,
    () => {
      const diagnostics = requireRuntime().diagnostics;
      if (!diagnostics) throw new Error("Browser diagnostics are disabled.");
      return diagnostics;
    },
    (ctx, signal) => {
      const current = requireRuntime();
      return {
        owner: ctx?.sessionManager?.getSessionId() ?? current.owner,
        signal: AbortSignal.any([
          current.controller.signal,
          ...(signal ? [signal] : []),
        ]),
      };
    },
    (target, ctx) => {
      const current = requireRuntime();
      current.sessions.authorize(
        target,
        ctx?.sessionManager?.getSessionId() ?? current.owner,
      );
    },
  );
  pi.registerTool({
    name: "browser_session",
    label: "Browser session",
    description:
      "Start and manage owned disposable Chromium sessions and explicitly selected tabs. Tool names registered later by other extensions follow Pi's registry load order.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("list"),
        Type.Literal("new_tab"),
        Type.Literal("select"),
        Type.Literal("close_tab"),
        Type.Literal("stop"),
      ]),
      sessionId: Type.Optional(Type.String()),
      tabId: Type.Optional(Type.String()),
      purpose: Type.Optional(
        Type.Union([Type.Literal("development"), Type.Literal("research")]),
      ),
      headless: Type.Optional(Type.Boolean()),
      profile: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      video: Type.Optional(
        Type.Boolean({
          description:
            "Record every page in the new context. The session closes at the recording deadline.",
        }),
      ),
    }),
    async execute(_id, args, signal, onUpdate, ctx) {
      const current = requireRuntime();
      const combined = AbortSignal.any([
        current.controller.signal,
        ...(signal ? [signal] : []),
      ]);
      const target = { sessionId: args.sessionId, tabId: args.tabId };
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      switch (args.action) {
        case "start": {
          const startupSignal = AbortSignal.any([
            combined,
            AbortSignal.timeout(current.settings.startupTimeoutMs),
          ]);
          const installed = await current.installer.ensure({
            trusted: current.trusted,
            autoInstall: current.settings.autoInstall,
            signal: startupSignal,
            timeoutMs: current.settings.startupTimeoutMs,
            progress: (text) =>
              onUpdate?.(result({ progress: text.slice(-512) })),
          });
          if (!installed.ok) {
            const guidance = installed.message.includes("macOS only")
              ? " Use a supported macOS host."
              : "";
            throw new Error(`${installed.message.slice(0, 2048)}${guidance}`);
          }
          return result(
            await current.sessions.start({
              purpose: args.purpose,
              headless: args.headless,
              profile: args.profile,
              video: args.video,
              artifactOwner: owner,
              signal: startupSignal,
            }),
          );
        }
        case "list":
          return textResult(formatSessionList(current.sessions.list(owner)));
        case "select":
          if (!args.sessionId || !args.tabId)
            throw new Error("select requires sessionId and tabId.");
          return result(
            current.sessions.select(
              {
                sessionId: args.sessionId,
                tabId: args.tabId,
              },
              owner,
            ),
          );
        case "new_tab":
          return result(
            await current.sessions.newTab(args.sessionId, combined, owner),
          );
        case "close_tab":
          return result(
            await current.sessions.closeTab(target, combined, owner),
          );
        case "stop":
          await current.sessions.stop(
            args.sessionId,
            current.settings.shutdownTimeoutMs,
            combined,
            owner,
          );
          return result({ stopped: true });
      }
    },
  });
  pi.registerTool({
    name: "browser_attachment",
    label: "Local browser attachment",
    description:
      "Experimental direct page-scoped CDP attachment, separate from managed Playwright sessions. Connect to a literal loopback endpoint, explicitly discover and lease one page, then use bounded title/text inspection, HTTP(S) navigation, or opt-in page diagnostics. Console arguments, headers and bodies are not captured; DOM text may include hidden or script content and secrets. Actions, screenshots, uploads, dialogs, recording and full Playwright facilities are unsupported. Disconnect never closes the external browser or tab. Timeouts and failures may quarantine ownership; no action is replayed.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("connect"),
        Type.Literal("list"),
        Type.Literal("targets"),
        Type.Literal("select"),
        Type.Literal("navigate"),
        Type.Literal("inspect"),
        Type.Literal("title"),
        Type.Literal("start_diagnostics"),
        Type.Literal("diagnostics"),
        Type.Literal("disconnect"),
      ]),
      endpoint: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      attachmentId: Type.Optional(
        Type.String({ minLength: 1, maxLength: 256 }),
      ),
      targetId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      url: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 30000 })),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const current = requireRuntime();
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      const combined = AbortSignal.any([
        current.controller.signal,
        ...(signal ? [signal] : []),
      ]);
      if (args.action === "connect") {
        if (!current.trusted)
          throw new Error(
            "Local browser attachment requires a trusted project.",
          );
        if (!args.endpoint)
          throw new Error("Connect requires an explicit loopback endpoint.");
        return result(
          await current.sessions.attachExternal(
            args.endpoint,
            owner,
            combined,
            args.timeoutMs,
          ),
        );
      }
      if (args.action === "list")
        return result({ attachments: current.sessions.listAttachments(owner) });
      if (!args.attachmentId)
        throw new Error("Explicit attachmentId is required.");
      if (args.action === "targets")
        return result(
          await current.sessions.attachmentTargets(
            args.attachmentId,
            owner,
            combined,
          ),
        );
      if (args.action === "disconnect") {
        try {
          return result(
            await current.sessions.disconnectAttachment(
              args.attachmentId,
              owner,
            ),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (
            message === "Browser runtime is shut down." ||
            message === "Attachment unavailable or owned by another Pi session."
          )
            throw new Error(message);
          throw new Error(
            "Attachment disconnect cleanup could not be verified; ownership may be quarantined. Verify no agent operation can still run before manual marker recovery. Never blindly signal PIDs or close the external browser as a recovery step.",
          );
        }
      }
      if (!args.targetId) throw new Error("Explicit targetId is required.");
      if (args.action === "select") {
        try {
          return result(
            await current.sessions.selectAttachment(
              args.attachmentId,
              owner,
              args.targetId,
              combined,
              args.timeoutMs,
            ),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          const safeErrors = new Set([
            "Browser runtime is shut down.",
            "Attachment unavailable or owned by another Pi session.",
            "Invalid attachment selection timeout.",
            "Attachment is busy; retry after its current operation settles.",
            "A page is already selected; disconnect before selecting another.",
            "Select an explicitly discovered page target ID.",
          ]);
          if (safeErrors.has(message)) throw new Error(message);
          if (combined.aborted)
            throw new Error(
              "Attachment selection cancelled. If ownership is unresolved, verify no agent operation can still run before manual marker recovery. Never blindly signal PIDs or close the external browser as a recovery step.",
            );
          const status =
            message.startsWith("Attachment ownership is unresolved") ||
            message.startsWith("Profile ownership is unresolved")
              ? "Attachment ownership is unresolved and remains quarantined."
              : "Attachment selection failed or timed out; ownership may be quarantined.";
          throw new Error(
            `${status} Verify no agent operation can still run before manual marker recovery. Never blindly signal PIDs or close the external browser as a recovery step.`,
          );
        }
      }
      if (args.action === "diagnostics")
        return result(
          current.sessions.attachmentDiagnostics(
            args.attachmentId,
            owner,
            args.targetId,
          ),
        );
      const value = await current.sessions.attachmentWork(
        args.attachmentId,
        owner,
        args.targetId,
        args.action,
        { url: args.url, timeoutMs: args.timeoutMs },
        combined,
      );
      return result(value);
    },
  });
  pi.registerTool({
    name: "browser_recording",
    label: "Browser recording",
    description:
      "Start or stop an owned context-wide native trace, inspect recording status, or list private recovery directories without deleting them. Recordings contain sensitive raw page data. Native temporary bytes are not quota-limited. Videos receive bounded structural checks, not a full decode. Request video when creating the session; the deadline closes the session.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start_trace"),
        Type.Literal("stop_trace"),
        Type.Literal("inspect"),
        Type.Literal("inspect_video"),
        Type.Literal("recovery"),
        Type.Literal("enable_video"),
      ]),
      sessionId: Type.Optional(Type.String()),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, maximum: RECORDING_RECOVERY_SCAN_LIMIT }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const current = requireRuntime();
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      if (args.action === "enable_video")
        throw new Error(
          "Video requires a new recording-enabled session; enabling it on this session would lose state. No session was restarted.",
        );
      if (args.action === "recovery")
        return result(
          await listRecordingRecovery(
            owner,
            args.offset ?? 0,
            args.limit ?? 20,
          ),
        );
      if (args.action === "inspect_video") {
        if (!args.sessionId)
          throw new Error("Video inspection requires sessionId.");
        const record = current.videos.inspect(args.sessionId, owner);
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 20;
        const totalVideos = record.videos.length;
        return result({
          ...record,
          videos: record.videos.slice(offset, offset + limit),
          totalVideos,
          nextOffset: offset + limit < totalVideos ? offset + limit : null,
        });
      }
      if (args.action === "inspect" && args.sessionId)
        return result(current.recordings.inspect(args.sessionId, owner));
      const combined = AbortSignal.any([
        current.controller.signal,
        AbortSignal.timeout(current.settings.shutdownTimeoutMs),
        ...(signal ? [signal] : []),
      ]);
      return result(
        await current.sessions.trace(
          args.action === "start_trace"
            ? "start"
            : args.action === "stop_trace"
              ? "stop"
              : "inspect",
          args.sessionId,
          owner,
          combined,
        ),
      );
    },
  });
  pi.registerTool({
    name: "browser_navigate",
    label: "Browser navigate",
    description: "Navigate an explicitly addressed or agent-selected tab.",
    parameters: Type.Object({
      url: Type.String({ minLength: 1, maxLength: 8192 }),
      sessionId: Type.Optional(Type.String()),
      tabId: Type.Optional(Type.String()),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const current = requireRuntime();
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      const combined = AbortSignal.any([
        current.controller.signal,
        AbortSignal.timeout(current.settings.navigationTimeoutMs),
        ...(signal ? [signal] : []),
      ]);
      return result(
        await current.sessions.navigate(
          args.url,
          { sessionId: args.sessionId, tabId: args.tabId },
          combined,
          current.settings.navigationTimeoutMs,
          owner,
        ),
      );
    },
  });
  const targetParameters = {
    sessionId: Type.Optional(Type.String()),
    tabId: Type.Optional(Type.String()),
  };
  const inspectionSignal = (
    current: NonNullable<typeof runtime>,
    signal?: AbortSignal,
  ) =>
    AbortSignal.any([
      current.controller.signal,
      AbortSignal.timeout(current.settings.navigationTimeoutMs),
      ...(signal ? [signal] : []),
    ]);
  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser snapshot",
    description:
      "Capture a bounded semantic snapshot of the owned tab. To scope a child frame, provide a Playwright frameSelector matching one iframe element in the main document; selector then scopes within that frame. Without frameSelector, a selector scopes only the main frame. References expire on navigation or the next snapshot.",
    parameters: Type.Object({
      ...targetParameters,
      selector: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
      frameSelector: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 1024,
          description:
            "Unique iframe element selector in the main document; nested frames are not directly selectable.",
        }),
      ),
      maxRecords: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
      maxChars: Type.Optional(Type.Integer({ minimum: 512, maximum: 32000 })),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const current = requireRuntime();
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      return result(
        await current.sessions.snapshot(
          args,
          owner,
          inspectionSignal(current, signal),
          {
            selector: args.selector,
            frameSelector: args.frameSelector,
            maxRecords: args.maxRecords,
            maxChars: args.maxChars,
          },
        ),
      );
    },
  });
  pi.registerTool({
    name: "browser_snapshot_ref",
    label: "Browser snapshot reference",
    description:
      "Validate or click the exact retained snapshot element. Click uses normal Playwright actionability checks, not a selector; page changes can still race with dispatch. Failure may leave the action outcome uncertain; no automatic retry is made.",
    parameters: Type.Object({
      ...targetParameters,
      ref: Type.String({ minLength: 1, maxLength: 128 }),
      action: Type.Optional(
        Type.Union([Type.Literal("validate"), Type.Literal("click")]),
      ),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 30000 })),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const current = requireRuntime();
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      const combined = inspectionSignal(current, signal);
      return result(
        args.action === "click"
          ? await current.sessions.clickSnapshotRef(
              args,
              owner,
              args.ref,
              combined,
              args.timeoutMs,
            )
          : await current.sessions.validateSnapshotRef(
              args,
              owner,
              args.ref,
              combined,
            ),
      );
    },
  });
  pi.registerTool({
    name: "browser_action",
    label: "Browser action",
    description:
      "Click, fill, select by option value, press a key, scroll an element into view, or wait until visible. Target an exact snapshot ref or a unique selector/role in an optional main-document iframe and section scope. Observers are armed before the action; text is sampled in the main document and may miss transient changes. A matching text, URL substring, or response URL substring proves only that condition, not application success. Input may have occurred on failure; never automatically retry.",
    parameters: Type.Object({
      ...targetParameters,
      action: Type.Union([
        Type.Literal("click"),
        Type.Literal("fill"),
        Type.Literal("select"),
        Type.Literal("press"),
        Type.Literal("scroll"),
        Type.Literal("wait"),
      ]),
      target: Type.Union([
        Type.Object(
          { ref: Type.String({ minLength: 1, maxLength: 128 }) },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            selector: Type.String({ minLength: 1, maxLength: 1024 }),
            frameSelector: Type.Optional(
              Type.String({ minLength: 1, maxLength: 1024 }),
            ),
            scopeSelector: Type.Optional(
              Type.String({ minLength: 1, maxLength: 1024 }),
            ),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            role: Type.String({ minLength: 1, maxLength: 64 }),
            name: Type.String({ maxLength: 500 }),
            frameSelector: Type.Optional(
              Type.String({ minLength: 1, maxLength: 1024 }),
            ),
            scopeSelector: Type.Optional(
              Type.String({ minLength: 1, maxLength: 1024 }),
            ),
          },
          { additionalProperties: false },
        ),
      ]),
      value: Type.Optional(Type.String({ maxLength: 10000 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 30000 })),
      expect: Type.Optional(
        Type.Object(
          {
            kind: Type.Union([
              Type.Literal("text"),
              Type.Literal("url"),
              Type.Literal("response"),
            ]),
            value: Type.String({ minLength: 1, maxLength: 1000 }),
            status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
          },
          { additionalProperties: false },
        ),
      ),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const current = requireRuntime();
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      const combined = AbortSignal.any([
        current.controller.signal,
        ...(signal ? [signal] : []),
      ]);
      return result(await current.sessions.action(args, owner, args, combined));
    },
  });
  pi.registerTool({
    name: "browser_handoff",
    label: "Browser human handoff",
    description:
      "Pause an owned visible session for human login or request a visible restart of a headless named-profile session. A restart requires separate explicit interactive or RPC user consent and may lose unsaved forms, open tabs, and in-memory state; old IDs expire and no actions are replayed. After restart, the new session awaits separate human login confirmation. Diagnostics and download capture are suspended during handoff.",
    parameters: Type.Object({
      ...targetParameters,
      action: Type.Union([
        Type.Literal("pause"),
        Type.Literal("status"),
        Type.Literal("request_visible_restart"),
        Type.Literal("cancel_visible_restart"),
      ]),
      restartId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    }),
    async execute(_id, args, _signal, _onUpdate, ctx) {
      const current = requireRuntime();
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      if (args.action === "status")
        return result(current.sessions.handoffStatus(args.sessionId, owner));
      if (args.action === "cancel_visible_restart") {
        if (!args.sessionId || !args.restartId)
          throw new Error("Cancellation requires sessionId and restartId.");
        return result(
          current.sessions.cancelVisibleRestart(
            args.sessionId,
            args.restartId,
            owner,
          ),
        );
      }
      if (!ctx?.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc"))
        return result({
          status: "unsupported",
          note: "Human handoff requires an interactive Pi session or an RPC client with UI. Headless workers cannot confirm the handoff. No browser state changed.",
        });
      if (args.action === "request_visible_restart")
        return result(current.sessions.requestVisibleRestart(args, owner));
      return result(await current.sessions.beginHandoff(args, owner));
    },
  });
  pi.registerTool({
    name: "browser_upload",
    label: "Browser upload",
    description:
      "Upload explicit local files to a snapshot-ref file input, or open a chooser by ref, unique selector, or exact role/name. Relative paths resolve from the Pi working directory; globs and directories are rejected. Final-component symlinks are rejected; parent-directory symlinks are followed. Files are read from opened descriptors before dispatch. MIME types are inferred from common extensions without content inspection, supplied explicitly, or default to application/octet-stream. No automatic retry.",
    parameters: Type.Object({
      ...targetParameters,
      ref: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      selector: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
      role: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      name: Type.Optional(Type.String({ maxLength: 500 })),
      frameSelector: Type.Optional(
        Type.String({ minLength: 1, maxLength: 1024 }),
      ),
      scopeSelector: Type.Optional(
        Type.String({ minLength: 1, maxLength: 1024 }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("input"), Type.Literal("chooser")]),
      ),
      paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        minItems: 1,
        maxItems: 10,
      }),
      mimeTypes: Type.Optional(
        Type.Array(Type.String({ minLength: 3, maxLength: 255 }), {
          minItems: 1,
          maxItems: 10,
        }),
      ),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 30000 })),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const current = requireRuntime();
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      const timeoutMs = args.timeoutMs ?? 30000;
      const combined = AbortSignal.any([
        current.controller.signal,
        AbortSignal.timeout(timeoutMs),
        ...(signal ? [signal] : []),
      ]);
      return result(
        await current.sessions.upload(
          args,
          owner,
          {
            ref: args.ref,
            selector: args.selector,
            role: args.role,
            name: args.name,
            frameSelector: args.frameSelector,
            scopeSelector: args.scopeSelector,
            mode: args.mode,
            paths: args.paths,
            mimeTypes: args.mimeTypes,
            cwd: ctx?.cwd ?? process.cwd(),
            timeoutMs,
            ...current.uploadLimits,
          },
          combined,
        ),
      );
    },
  });
  pi.registerTool({
    name: "browser_dialog",
    label: "Browser dialog",
    description:
      "Inspect or refresh the last observed owned-tab dialog, explicitly accept or dismiss its exact ID, or inspect its originating operation. A prearmed monitor detects correlated external dismissals; refresh reports unknown if closure is not verified and never sends a response. Never auto-accepts; the session stays blocked until resolution or owned-session cleanup.",
    parameters: Type.Object({
      ...targetParameters,
      action: Type.Union([
        Type.Literal("inspect"),
        Type.Literal("refresh"),
        Type.Literal("accept"),
        Type.Literal("dismiss"),
        Type.Literal("operation"),
      ]),
      id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      operationId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      promptText: Type.Optional(Type.String({ maxLength: 1000 })),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const current = requireRuntime();
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      const combined = AbortSignal.any([
        current.controller.signal,
        ...(signal ? [signal] : []),
      ]);
      return result(await current.sessions.dialog(args, owner, args, combined));
    },
  });
  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser screenshot",
    description:
      "Capture the owned tab viewport, full page, or an exact snapshot element. Returns the original PNG directly and a private owner-scoped artifact ID; use browser_artifact export to save it. Element capture may scroll. Oversized captures fail explicitly. Screenshots can contain sensitive page content.",
    parameters: Type.Object({
      ...targetParameters,
      scope: Type.Optional(
        Type.Union([
          Type.Literal("viewport"),
          Type.Literal("fullPage"),
          Type.Literal("element"),
        ]),
      ),
      ref: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      transparent: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const current = requireRuntime();
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      const combined = AbortSignal.any([
        current.controller.signal,
        ...(signal ? [signal] : []),
      ]);
      const captured = await current.sessions.screenshot(
        args,
        owner,
        current.artifacts,
        {
          scope: args.scope ?? "viewport",
          ref: args.ref,
          transparent: args.transparent,
          limits: current.screenshotLimits,
        },
        combined,
      );
      const [metadataBlock, image] = captured.content;
      if (metadataBlock?.type !== "text" || image?.type !== "image")
        throw new Error("Invalid screenshot result.");
      const metadata = JSON.parse(metadataBlock.text);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ target: captured.target, ...metadata }),
          },
          image,
        ],
        details: undefined,
      };
    },
  });
  pi.registerTool({
    name: "browser_viewport",
    label: "Browser viewport",
    description:
      "Resize the owned tab viewport using custom CSS dimensions or phone/tablet presets. This does not emulate touch, user agent, or real devices.",
    parameters: Type.Object({
      ...targetParameters,
      choice: Type.Union([
        Type.Object(
          {
            width: Type.Integer({ minimum: 1, maximum: 32768 }),
            height: Type.Integer({ minimum: 1, maximum: 32768 }),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            preset: Type.Union([Type.Literal("phone"), Type.Literal("tablet")]),
          },
          { additionalProperties: false },
        ),
      ]),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const current = requireRuntime();
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      const combined = AbortSignal.any([
        current.controller.signal,
        ...(signal ? [signal] : []),
      ]);
      return result(
        await current.sessions.viewport(
          args,
          owner,
          args.choice,
          current.screenshotLimits,
          combined,
        ),
      );
    },
  });
  pi.registerTool({
    name: "browser_pick",
    label: "Human element picker",
    description:
      "Ask the user to select up to 20 elements in an owned visible tab, including existing same-process and out-of-process child frames. Multi-selection finishes at its limit or through the user-facing finish instruction. Frame attachment, detachment, or navigation cancels the batch; Escape and abort also cancel it. Returns bounded non-actionable metadata including parent context and a synthetic element summary, not original HTML or an actionable selector. Form-control values are excluded, but arbitrary page text or attributes may contain secrets despite best-effort redaction. Input may reach the page during frame changes or if the input gate disconnects.",
    parameters: Type.Object({
      ...targetParameters,
      selectionMode: Type.Optional(
        Type.Union([Type.Literal("single"), Type.Literal("multiple")]),
      ),
      maxSelections: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, args, signal, onUpdate, ctx) {
      const current = requireRuntime();
      const maxSelections =
        args.maxSelections ?? (args.selectionMode === "multiple" ? 20 : 1);
      if (args.selectionMode === "single" && maxSelections !== 1)
        throw new Error("Single selection requires maxSelections=1.");
      if (args.selectionMode === "multiple" && maxSelections < 2)
        throw new Error(
          "Multi-selection requires maxSelections of at least 2.",
        );
      if (
        maxSelections > 1 &&
        (!ctx?.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc"))
      )
        return result({
          status: "unsupported",
          reason:
            "Multi-selection requires an interactive or RPC UI for the user-facing finish signal.",
        });
      const combined = AbortSignal.any([
        current.controller.signal,
        ...(signal ? [signal] : []),
      ]);
      return result(
        await current.sessions.pick(
          args,
          ctx?.sessionManager?.getSessionId() ?? current.owner,
          combined,
          {
            maxSelections,
            onReady: ({ target, pickerId }) => {
              const instructions =
                maxSelections > 1
                  ? `After selecting at least one element, send exactly: browser-pick-finish ${target.sessionId} ${pickerId}. Reaching the selection limit also finishes. Escape cancels the batch.`
                  : "Select one element in the visible browser. Escape cancels.";
              try {
                onUpdate?.(
                  result({
                    target,
                    status: "awaiting_user_selection",
                    pickerId,
                    maxSelections,
                    instructions,
                  }),
                );
              } catch {}
              if (ctx?.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc"))
                try {
                  ctx.ui.notify(instructions, "info");
                } catch {}
            },
          },
        ),
      );
    },
  });
  registerExtractionTools(pi, (ctx, signal) => {
    const current = requireRuntime();
    const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
    return {
      artifacts: current.artifacts,
      owner,
      signal: inspectionSignal(current, signal),
      runPage: (target, combined, work) =>
        current.sessions.withOwnedPage(
          target,
          combined,
          owner,
          (page, resolved) =>
            work(page, resolved, (identity) =>
              current.sessions.requestedUrlFor(page, identity),
            ),
        ),
    };
  });
  pi.registerTool({
    name: "browser_content",
    label: "Browser content",
    description:
      "Inspect serialized main-document HTML. This excludes iframe documents, shadow roots, and runtime-only form state; use eval for specific values. Large results are saved as private artifacts.",
    parameters: Type.Object(targetParameters),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const current = requireRuntime();
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      const combined = inspectionSignal(current, signal);
      const value = await current.sessions.content(args, combined, owner);
      return textResult(
        await inspectionOutput(
          current.artifacts,
          owner,
          value.html,
          {
            target: value.target,
            scope:
              "main document HTML; excludes iframe documents and shadow roots; runtime form properties may differ",
            representation: "html",
          },
          combined,
        ),
      );
    },
  });
  pi.registerTool({
    name: "browser_eval",
    label: "Browser eval",
    description:
      "Evaluate and await a JavaScript expression in the main frame. Strings are returned as text, JSON-compatible plain values as JSON; unsupported values fail explicitly. Large results are saved as private artifacts.",
    parameters: Type.Object({
      ...targetParameters,
      code: Type.String({ minLength: 1, maxLength: 200000 }),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const current = requireRuntime();
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      const combined = inspectionSignal(current, signal);
      const value = await current.sessions.evaluate(
        args.code,
        args,
        combined,
        owner,
      );
      if ("status" in value && value.status === "awaiting_dialog")
        return result(value);
      return textResult(
        await inspectionOutput(
          current.artifacts,
          owner,
          value.text,
          {
            target: value.target,
            scope: "main frame",
            representation: value.representation,
          },
          combined,
        ),
      );
    },
  });
  pi.registerTool({
    name: "browser_artifact",
    label: "Browser artifact",
    description:
      "Read a UTF-8 or binary artifact chunk or explicitly export the complete artifact to a new absolute path. IDs are scoped to the creating Pi session; export never overwrites.",
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("read"),
        id: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        maxBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: 65536 })),
      }),
      Type.Object({
        action: Type.Literal("read_binary"),
        id: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 32768 })),
      }),
      Type.Object({
        action: Type.Literal("export"),
        id: Type.String(),
        path: Type.String({ minLength: 1, maxLength: 4096 }),
      }),
      Type.Object({ action: Type.Literal("cleanup") }),
    ]),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const current = requireRuntime();
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      const combined = inspectionSignal(current, signal);
      if (args.action === "read")
        return textResult(
          await chunkOutput(
            current.artifacts,
            owner,
            args.id,
            args.offset ?? 0,
            args.maxBytes ?? 65536,
            combined,
          ),
        );
      if (args.action === "read_binary")
        return textResult(
          await binaryChunkOutput(
            current.artifacts,
            owner,
            args.id,
            args.offset ?? 0,
            args.maxBytes ?? 32768,
            combined,
          ),
        );
      if (args.action === "export")
        return textResult(
          JSON.stringify(
            await current.artifacts.export(owner, args.id, args.path, combined),
          ),
        );
      return textResult(
        JSON.stringify(await current.artifacts.cleanup(combined)),
      );
    },
  });
  pi.registerTool({
    name: "browser_download",
    label: "Browser downloads",
    description:
      "List, inspect, wait for, or cancel downloads from an owned browser session. Capture remains suspended after human handoff until the owner explicitly calls resume_capture with acknowledgeRisk=true. After re-enabling, delayed human downloads may be saved as agent artifacts. Completed files are private artifacts; they are never opened or executed. The retained-file limit does not bound browser/network temporary bytes.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("inspect"),
        Type.Literal("wait"),
        Type.Literal("cancel"),
        Type.Literal("capture_status"),
        Type.Literal("resume_capture"),
      ]),
      sessionId: Type.String({ minLength: 1, maxLength: 256 }),
      acknowledgeRisk: Type.Optional(Type.Boolean()),
      id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 300000 })),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const current = requireRuntime();
      const owner = ctx?.sessionManager?.getSessionId() ?? current.owner;
      if (!current.downloads.owns(args.sessionId, owner))
        throw new Error(
          "Download session unavailable or owned by another Pi session.",
        );
      const combined = AbortSignal.any([
        current.controller.signal,
        ...(signal ? [signal] : []),
      ]);
      if (combined.aborted) throw new Error("Download operation cancelled.");
      if (args.action === "capture_status")
        return result(current.downloads.captureStatus(args.sessionId, owner));
      current.sessions.assertSessionNotPaused?.(args.sessionId, owner);
      if (args.action === "resume_capture") {
        if (args.acknowledgeRisk !== true)
          throw new Error(
            "Resuming capture requires acknowledgeRisk=true: delayed human downloads may be saved as agent artifacts.",
          );
        return result(
          current.sessions.resumeDownloadCapture(args.sessionId, owner),
        );
      }
      if (args.action === "list") {
        const records = current.downloads.list(args.sessionId);
        const output = {
          downloads: records,
          omitted: 0,
          saturation: current.downloads.saturation(args.sessionId),
          capture: current.downloads.captureStatus(args.sessionId, owner),
          notice: current.downloads.notice,
        };
        while (
          Buffer.byteLength(JSON.stringify(output)) > 16000 &&
          records.length
        ) {
          records.shift();
          output.omitted++;
        }
        return result(output);
      }
      if (!args.id) throw new Error("Download id is required.");
      if (args.action === "inspect")
        return result(current.downloads.inspect(args.sessionId, args.id));
      if (args.action === "wait")
        return result(
          await current.downloads.wait(args.sessionId, args.id, {
            signal: combined,
            timeoutMs: args.timeoutMs,
          }),
        );
      const cancellation = current.downloads.cancel(args.sessionId, args.id);
      let onAbort: (() => void) | undefined;
      try {
        const cancelled = new Promise<never>((_, reject) => {
          onAbort = () =>
            reject(
              new Error(
                "Download cancellation requested; cleanup remains pending and its outcome is unverified.",
              ),
            );
          combined.addEventListener("abort", onAbort, { once: true });
          if (combined.aborted) onAbort();
        });
        return result(await Promise.race([cancellation, cancelled]));
      } finally {
        if (onAbort) combined.removeEventListener("abort", onAbort);
      }
    },
  });
  pi.on("input", async (event, ctx) => {
    if (
      !runtime ||
      !ctx.hasUI ||
      (ctx.mode !== "tui" && ctx.mode !== "rpc") ||
      (event.source !== "interactive" && event.source !== "rpc")
    )
      return { action: "continue" };
    const finish = /^browser-pick-finish ([^\s]{1,256}) ([a-f0-9-]{36})$/.exec(
      event.text.trim(),
    );
    if (finish) {
      try {
        const owner = ctx.sessionManager?.getSessionId() ?? runtime.owner;
        runtime.sessions.finishPick(finish[1], finish[2], owner);
        try {
          ctx.ui.notify("Finishing the browser selection.", "info");
        } catch {}
      } catch (error) {
        try {
          ctx.ui.notify(
            `Picker was not finished: ${String(error).slice(0, 300)}`,
            "error",
          );
        } catch {}
      }
      return { action: "handled" };
    }
    const restart =
      /^browser-visible-restart ([^\s]{1,256}) ([a-f0-9-]{36})$/.exec(
        event.text.trim(),
      );
    if (restart) {
      const current = runtime;
      try {
        const owner = ctx.sessionManager?.getSessionId() ?? current.owner;
        const restarted = await current.sessions.confirmVisibleRestart(
          restart[1],
          restart[2],
          owner,
          AbortSignal.any([
            current.controller.signal,
            AbortSignal.timeout(
              current.settings.startupTimeoutMs +
                current.settings.shutdownTimeoutMs,
            ),
          ]),
        );
        try {
          ctx.ui.notify(
            `Visible browser ready. ${restarted.instructions} Unsaved forms and in-memory state may have been lost.`,
            "info",
          );
        } catch {
          /* Status remains available through browser_handoff. */
        }
        return { action: "continue" };
      } catch (error) {
        ctx.ui.notify(
          `Visible restart was not completed: ${String(error).slice(0, 300)}`,
          "error",
        );
        return { action: "handled" };
      }
    }
    const match = /^browser-resume ([^\s]{1,256}) ([a-f0-9-]{36})$/.exec(
      event.text.trim(),
    );
    if (!match) return { action: "continue" };
    try {
      const owner = ctx.sessionManager?.getSessionId() ?? runtime.owner;
      const resumed = runtime.sessions.confirmHandoff(
        match[1],
        match[2],
        owner,
      );
      try {
        ctx.ui.notify(
          `Browser session ${match[1]} resumed after your confirmation.${resumed.diagnosticsGap ? ` ${resumed.diagnosticsGap}` : ""}${resumed.downloadGap ? ` Agent download capture remains suspended; ${resumed.downloadGap.ignored} download event(s) were ignored by confirmation.` : ""}`,
          "info",
        );
      } catch {
        /* Status remains available through browser_handoff. */
      }
      return { action: "continue" };
    } catch (error) {
      ctx.ui.notify(
        `Browser handoff remains paused: ${String(error).slice(0, 300)}`,
        "error",
      );
      return { action: "handled" };
    }
  });
  pi.on("session_start", async (_event, ctx) => {
    const currentVersion = ++version;
    await stop();
    const rawSettings = (await loadSettings(ctx)).values[BROWSER_SETTINGS_ID];
    const settings = resolveBrowserSettings(rawSettings);
    const screenshotLimits = resolveScreenshotLimits(rawSettings);
    const uploadLimits = resolveUploadLimits(rawSettings);
    if (currentVersion !== version || !settings.enabled) return;
    const existing = registeredTools();
    const collisions = BROWSER_TOOL_NAMES.filter((name) =>
      existing
        ? existing.some(
            (tool) =>
              tool.name === name && (!registered || !isOwned(name, existing)),
          )
        : !registered && pi.getActiveTools().includes(name),
    );
    if (collisions.length) {
      const warning = `Managed browser tools disabled because tool names are already registered by another extension: ${collisions.join(", ")}. Existing tool activation was not changed. Later registrations follow Pi's registry load order.`;
      if (ctx.hasUI) ctx.ui.notify(warning, "warning");
      else console.warn(warning);
      return;
    }
    const artifacts =
      options.createArtifacts?.(settings) ??
      new ArtifactStore({
        quota: settings.artifactQuotaBytes,
        ttl: settings.artifactTtlMs,
      });
    const diagnostics = settings.diagnosticsEnabled
      ? new BrowserDiagnostics({
          bodyArtifactSink: (owner, bytes, signal) =>
            artifacts.putBinary(
              owner,
              (async function* () {
                yield bytes;
              })(),
              { maxBytes: bytes.length, signal },
            ),
          maxEntries: settings.diagnosticsMaxEntries,
          maxBytes: settings.diagnosticsMaxBytes,
        })
      : undefined;
    const recordings = new TraceRecordings({
      sink: artifacts,
      durationMs: settings.recordingDurationMs,
      maxBytes: settings.artifactQuotaBytes,
      timeoutMs: settings.shutdownTimeoutMs,
    });
    const videos = new VideoRecordings({
      sink: artifacts,
      durationMs: settings.recordingDurationMs,
      maxBytes: settings.artifactQuotaBytes,
      timeoutMs: settings.shutdownTimeoutMs,
    });
    let sessions: ManagedSessions;
    const downloads = new DownloadManager({
      sink: artifacts,
      onOverflow: (sessionId) => sessions?.failClosed(sessionId),
    });
    sessions =
      options.createSessions?.(diagnostics, downloads, recordings, videos) ??
      new ManagedSessions({
        launch: ({ headless }) =>
          chromium.launch({ headless, channel: "chromium" }),
        launchPersistent: (path, { headless, recordVideo }) =>
          chromium.launchPersistentContext(path, {
            headless,
            recordVideo,
            channel: "chromium",
          }),
        profileWaitMs: settings.profileWaitTimeoutMs,
        diagnostics,
        downloads,
        recordings,
        videos,
        downloadCloseTimeoutMs: settings.shutdownTimeoutMs,
      });
    runtime = {
      diagnostics,
      downloads,
      recordings,
      videos,
      sessions,
      installer: options.createInstaller?.() ?? new ChromiumInstaller(),
      controller: new AbortController(),
      trusted: ctx.isProjectTrusted(),
      owner: ctx.sessionManager?.getSessionId() ?? randomUUID(),
      artifacts,
      settings,
      screenshotLimits,
      uploadLimits,
    };
    if (!registered) {
      const before = new Set(pi.getActiveTools());
      try {
        for (const definition of definitions) realPi.registerTool(definition);
        registered = true;
      } finally {
        for (const name of BROWSER_TOOL_NAMES)
          if (!before.has(name) && pi.getActiveTools().includes(name))
            activated.add(name);
      }
    }
    const enabledNames = BROWSER_TOOL_NAMES.filter(
      (name) =>
        settings.diagnosticsEnabled ||
        !DIAGNOSTIC_TOOL_NAMES.includes(
          name as (typeof DIAGNOSTIC_TOOL_NAMES)[number],
        ),
    );
    const allowed = new Set<string>(enabledNames);
    for (const name of enabledNames) activated.add(name);
    pi.setActiveTools([
      ...new Set([
        ...pi
          .getActiveTools()
          .filter((name) => !activated.has(name) || allowed.has(name)),
        ...enabledNames,
      ]),
    ]);
  });
  pi.on("session_shutdown", async () => {
    ++version;
    await stop();
  });
}
