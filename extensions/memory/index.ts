import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import Database from "better-sqlite3";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type DuplicateIdWarning,
  MemoryManager,
} from "./core.ts";
import {
  getSettingValue,
  publishExtensionSettings,
} from "../../lib/pi-tools-config.ts";
import {
  MemoryScheduler,
  REVIEW_GAP_REASONS,
  UNSUPPORTED_FILE_SOURCE,
  persistSchedulerActivity,
  reviewProjectSessions,
  type SchedulerOptions,
  type SchedulerReport,
} from "./scheduler.ts";
import {
  createConfiguredPiMemoryReviewer,
  type ReviewerStore,
} from "./reviewer.ts";
import { reviewAllMemories } from "./manual-review.ts";
import {
  getRuntimeSettings,
  isExtensionEnabled,
  removeDisabledTools,
} from "../../lib/pi-tools-runtime-settings.ts";

const MEMORY_EXTENSION_ID = "memory";
const MEMORY_TOOL_NAMES = [
  "memory_remember",
  "memory_recall",
  "memory_update",
  "memory_forget",
  "memory_init",
  "memory_repair",
  "memory_learn",
  "memory_consolidate",
  "memory_review",
  "memory_list",
] as const;

function isMemoryCategory(value: string | undefined): value is MemoryCategory {
  return (
    value !== undefined && MEMORY_CATEGORIES.includes(value as MemoryCategory)
  );
}

const NOT_ENABLED_MESSAGE =
  "Memory tracking is not enabled for this project. Run `memory_init` to create the memory store and enable it.";

const DUPLICATE_REVIEW_GUIDANCE =
  "Run /memory-review full to repair duplicate IDs. Configured background review also repairs them when it runs.";

function formatDuplicateWarning(warning: DuplicateIdWarning): string {
  return `Duplicate memory id ${warning.id}. ${DUPLICATE_REVIEW_GUIDANCE}`;
}

function formatRecall(
  result: Awaited<ReturnType<MemoryManager["recall"]>>,
): string {
  const warnings = result.warnings?.map(formatDuplicateWarning).join("\n");
  const fallback =
    result.searchMode === "grep" && result.warnings?.length
      ? "Duplicate IDs prevent indexing. Search uses case-insensitive literal substring matching and may miss relevant memories."
      : undefined;
  if (result.memories.length === 0) {
    return [
      `Search mode: ${result.searchMode}`,
      fallback,
      "No memory matches found.",
      warnings,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const sections: string[] = [`Search mode: ${result.searchMode}`];
  if (fallback) sections.push(fallback);
  if (warnings) sections.push(`Memory warnings:\n${warnings}`);

  sections.push(
    `Memories:\n${result.memories
      .map(
        (memory) =>
          `- [${memory.category}] ${memory.id.slice(0, 8)} ${memory.content}`,
      )
      .join("\n")}`,
  );

  return sections.join("\n\n");
}

type RememberResultDetails = {
  kind: "memory_remember";
  category: MemoryCategory;
  content: string;
  id: string;
  created: boolean;
};

function isRememberResultDetails(
  details: unknown,
): details is RememberResultDetails {
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { kind?: unknown }).kind === "memory_remember" &&
    isMemoryCategory((details as { category?: string }).category) &&
    typeof (details as { content?: unknown }).content === "string" &&
    typeof (details as { id?: unknown }).id === "string" &&
    typeof (details as { created?: unknown }).created === "boolean"
  );
}

export function createTrackedReviewStore(
  manager: MemoryManager,
  changes: Array<{ id: string; detail: string }>,
): ReviewerStore {
  const text = (content: string) =>
    content.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 120);
  return {
    captureAddPrecondition: () => manager.captureAddPrecondition(),
    remember: async (...args) => {
      const result = await manager.remember(...args);
      if (result.created)
        changes.push({
          id: result.memory.id,
          detail: `Added [${result.memory.category}]: ${text(result.memory.content)}`,
        });
      return result;
    },
    update: async (...args) => {
      const result = await manager.update(...args);
      if (result)
        changes.push({
          id: result.id,
          detail: `Updated [${result.category}]: ${text(result.content)}`,
        });
      return result;
    },
    forget: async (...args) => {
      const result = await manager.forget(...args);
      if (result)
        changes.push({
          id: result.id,
          detail: `Removed [${result.category}]: ${text(result.content)}`,
        });
      return result;
    },
    move: async (...args) => {
      const result = await manager.move(...args);
      changes.push({
        id: result.id,
        detail: `Moved [${args[0].record.category} -> ${result.category}]: ${text(result.content)}`,
      });
      return result;
    },
  };
}

// These fixed messages contain no provider response, path, or project data.
const REVIEW_DIAGNOSTICS: Record<string, string> = {
  "malformed reviewer evidence requests":
    "Reviewer returned invalid evidence requests. Retry or use a different reviewer model.",
  "malformed reviewer response":
    "Reviewer returned a response that does not match the required schema. Retry or use a different reviewer model.",
  "unsupported reviewer action":
    "Reviewer returned an unsupported action. Retry or use a different reviewer model.",
  "malformed citation":
    "Reviewer returned an invalid citation. Retry or use a different reviewer model.",
  "malformed target id":
    "Reviewer returned an invalid target ID. Retry or use a different reviewer model.",
  "malformed category":
    "Reviewer returned an invalid memory category. Retry or use a different reviewer model.",
  "malformed memory content":
    "Reviewer returned invalid memory content. Retry or use a different reviewer model.",
  "malformed reason":
    "Reviewer returned an invalid reason. Retry or use a different reviewer model.",
  "malformed target authority":
    "Reviewer returned an invalid target authority. Retry or use a different reviewer model.",
  "malformed evidence sufficiency":
    "Reviewer returned invalid evidence sufficiency. Retry or use a different reviewer model.",
  "malformed evidence assessment":
    "Reviewer returned an invalid evidence assessment. Retry or use a different reviewer model.",
  "unknown memory target":
    "Reviewer selected a memory outside the current page. Retry or use a different reviewer model.",
  "invalid project-relative evidence path":
    "Reviewer requested an invalid evidence path. Retry or use a different reviewer model.",
  "private or hidden evidence path is excluded":
    "Reviewer requested excluded private or hidden evidence. Retry or use a different reviewer model.",
  "symlink evidence is unsupported":
    "Reviewer requested symlink evidence, which is unsupported. Retry or use a different reviewer model.",
  "evidence escapes project root":
    "Reviewer requested evidence outside the project. Retry or use a different reviewer model.",
  "requested missing path exists":
    "Reviewer requested a missing-path check for a path that exists. Retry or use a different reviewer model.",
  "evidence is not a bounded regular file":
    "Reviewer requested evidence that is not a bounded regular file. Retry or use a different reviewer model.",
  "binary evidence is unsupported":
    "Reviewer requested binary evidence, which is unsupported. Retry or use a different reviewer model.",
  "no matching paragraph":
    "Reviewer requested an excerpt with no matching paragraph. Retry or use a different reviewer model.",
  "matching paragraph exceeds excerpt limit":
    "Requested evidence paragraph exceeds the excerpt limit. Retry or use a different reviewer model.",
  "evidence call limit reached":
    "Evidence request limit reached. Retry or use a different reviewer model.",
  "evidence byte limit reached":
    "Evidence byte limit reached. Retry or use a different reviewer model.",
  "invalid evidence query":
    "Reviewer returned an invalid evidence query. Retry or use a different reviewer model.",
  "evidence changed during read":
    "Evidence changed during review. Retry after project changes settle.",
  "evidence truncated during read":
    "Evidence changed during review. Retry after project changes settle.",
  "evidence changed since review":
    "Evidence changed during review. Retry after project changes settle.",
  "memory review snapshot conflict":
    "Memory changed during review. Retry after memory changes settle.",
  "review snapshot changed or is missing; restart at zero":
    "Memory changed since the saved review cursor. Restart the full review from zero.",
  "memory snapshot exceeds review limit":
    "Memory snapshot exceeds the review limit. Reduce the memory corpus before retrying.",
  "single memory exceeds review page limit":
    "A memory exceeds the review page limit. Reduce its size before retrying.",
  "invalid memory snapshot":
    "Memory snapshot is invalid. Inspect the memory files before retrying.",
  "review model must be explicitly configured as provider/model":
    "Configure the reviewer model as provider/model before retrying.",
};

// Provider and filesystem errors can contain credentials, paths, or user data.
// Only display known diagnostic messages; never echo arbitrary exception text.
function safeReviewDetail(detail: unknown): string {
  if (typeof detail !== "string")
    return "Review failed. Check the reviewer model configuration and .pi/memory files; inspect before retrying.";
  if (Object.hasOwn(REVIEW_DIAGNOSTICS, detail))
    return REVIEW_DIAGNOSTICS[detail];
  // Status formatting applies this sanitizer again to the already-safe report.
  if (Object.values(REVIEW_DIAGNOSTICS).includes(detail)) return detail;
  const known = [
    "review model must be explicitly configured",
    "review model unavailable or not a chat model",
    "review model lacks text input capability",
    "review model authentication unavailable",
    "review model input exceeds byte limit or is invalid",
    "review model response exceeds byte limit",
    "review model returned malformed JSON",
    "project review is active",
    "project review is paused or interrupted; inspect and explicitly resume first",
    "review scheduler is starting; try again shortly",
    "invalid durable manual review cursor",
    "Duplicate ID repair may be incomplete; inspect memory files before resuming.",
    "Review stopped after applying changes; inspect before retrying.",
    "Full review stopped after applying changes; inspect before retrying.",
    "Cancelled; a partial apply may have occurred. Inspect before retrying.",
    "Cancellation or shutdown may have interrupted an apply; inspect before retrying.",
    "Cancellation was requested from another process; work may have completed. Inspect before retrying.",
    "A review stopped while marked in flight; inspect before resuming.",
    "Previous review was interrupted; inspect before resuming.",
    "Review outcome is uncertain; inspect before resuming.",
    "Shutdown timed out while work was active.",
    "Some session sources are incomplete or unavailable.",
  ];
  if (known.includes(detail)) return detail;
  if (/duplicate (?:memory )?ids?/i.test(detail))
    return `Duplicate memory IDs were detected. ${DUPLICATE_REVIEW_GUIDANCE}`;
  if (
    /^review model returned malformed JSON \((?:empty text|invalid fenced JSON|invalid JSON or unsupported wrapper); [0-9]{1,5} text bytes\)$(?![\s\S])/.test(
      detail,
    )
  )
    return detail;
  if (detail.startsWith("review model did not complete:"))
    return "Review model did not complete. Check the model provider and configuration.";
  return "Review failed. Check the reviewer model configuration and .pi/memory files; inspect before retrying.";
}

const SAFE_REVIEW_OUTCOME_DETAILS = new Set([
  "Insufficient evidence for this memory page; inspect evidence gaps.",
  "Full review traversal finished with insufficient or unknown evidence; retry the full review.",
  "Review found an unresolved evidence or authority conflict; inspect before resuming.",
  "Incremental review has insufficient evidence; batch remains unacknowledged for retry.",
  "Unresolved evidence or authority conflict.",
  "Exact duplicate memory requires review; no safe duplicate removal was proposed.",
  "Memory citation does not establish an exact same-category duplicate.",
  "Existing memory authority is unknown.",
  "Explicit guidance is protected without a demonstrably later direct user instruction.",
  "Memory is already in that category.",
  "Independent evidence assessment found unsupported or uncertain support.",
  "Matching memory exists; re-review remains required.",
  "Possible duplicate or opposite-sense memory requires review.",
  "Full model review pass finished. Evidence gaps may remain; no-change decisions do not verify that memories are current.",
  "Full review reached its pass limit; request another review to continue.",
  "Review pass limit reached; work remains pending.",
  "More session entries remain.",
  "The explicitly opened session filename is not JSONL; activity remains pending.",
  "Review was cancelled; activity remains pending.",
  "Background session review completed.",
]);

type ReviewStatusReport = {
  status: SchedulerReport["status"];
  configuredModel: string | null;
  historyEnabled: boolean;
  events: SchedulerReport["events"];
};

// Provider diagnostics are allowlisted; recorded changes are bounded and
// cleaned for terminal display, while structured details remain unchanged.
function safeChangeText(detail: string): string {
  const clean = detail
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[0-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 150 ? `${clean.slice(0, 149)}…` : clean;
}
function displayUnresolvedDetail(detail: string): string {
  if (
    detail ===
    "Review found an unresolved evidence or authority conflict; inspect before resuming."
  )
    return "Review found an unresolved evidence or authority conflict; inspect the report before retrying.";
  return SAFE_REVIEW_OUTCOME_DETAILS.has(detail) ||
    detail ===
      "Review found an unresolved evidence or authority conflict; inspect the report before retrying."
    ? detail
    : "Unresolved review. Details are unavailable or hidden; inspect the report before retrying.";
}

function formatReviewDiagnostics(
  review: NonNullable<SchedulerReport["events"][number]["review"]>,
): string {
  const parts: string[] = [];
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (valid(review.memoryEvaluations))
    parts.push(
      `Memory evaluations: ${review.memoryEvaluations}${valid(review.snapshotMemories) ? `; last snapshot records: ${review.snapshotMemories}` : ""} (evaluations may repeat after changes)`,
    );
  const reasons = REVIEW_GAP_REASONS.flatMap((key) => {
    const value = review.gapReasons?.[key];
    return valid(value) ? [`${key.replaceAll("_", " ")}: ${value}`] : [];
  });
  if (reasons.length)
    parts.push(
      `Evidence gap pages by reason (may overlap): ${reasons.join(", ")}`,
    );
  return parts.join(". ");
}

export function formatReviewStatus(
  report: ReviewStatusReport,
  omittedEvents = 0,
): string {
  const s = report.status;
  const timestamp = (value: number) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : "unknown";
  };
  const model = report.configuredModel;
  const safeModel =
    model && model.length <= 120 && /^[\w.-]+\/[\w.:-]+$/.test(model)
      ? model
      : model
        ? "configured (name hidden)"
        : "not configured";
  const state = s.paused
    ? `paused${s.inflight ? " (work in flight)" : ""}`
    : s.inflight
      ? "running"
      : "idle";
  const lines = [
    "Memory review report",
    `State: ${state}`,
    `Scheduler status: ${["idle", "pending", "running", "manual-running", "done", "error", "unresolved", "uncertain", "cancelled", "interrupted-uncertain", "shutdown-uncertain", "unsupported-session"].includes(s.status) ? s.status : "unknown"}`,
    `Pending: ${s.pending}; unsupported sessions: ${s.unsupportedSessions}`,
    `History review: ${report.historyEnabled ? "enabled" : "disabled"}`,
    `Reviewer model: ${safeModel}`,
  ];
  if (s.unpersistedActivities || s.activityFlushPending)
    lines.push(
      `Activity awaiting persistence: ${s.unpersistedActivities}${s.activityFlushPending ? " (flush pending)" : ""}`,
    );
  if (s.manualContinuation)
    lines.push(
      `Full review continuation: offset ${s.manualContinuation.offset}`,
    );
  if (s.cooldownUntil > 0)
    lines.push(`Cooldown until: ${timestamp(s.cooldownUntil)}`);
  if (s.paused && s.inflight)
    lines.push(
      "Next: Work may still finish. Wait for it to settle, then inspect before resuming.",
    );
  else if (s.paused)
    lines.push(
      "Next: Inspect the latest outcome before using /memory-review resume. To continue a full review, use /memory-review full after resuming.",
    );
  else if (s.inflight)
    lines.push("Next: Review is running. Check status again after it settles.");
  else if (s.status === "unresolved")
    lines.push(
      "Next: Inspect the unresolved outcome. Run /memory-review full again to retry; unresolved work may remain.",
    );
  lines.push("", "Recent runs (each run is separate):");
  if (!report.events.length) lines.push("  None.");
  for (const event of report.events) {
    const mode = event.mode === "manual" ? "manual" : "background";
    const status = [
      "done",
      "pending",
      "error",
      "unresolved",
      "uncertain",
      "unsupported-session",
      "repair",
      "cancelled",
    ].includes(event.status)
      ? event.status
      : "unknown";
    lines.push(`- ${timestamp(event.at)} | ${mode} | ${status}`);
    if (event.status === "error" || event.status === "uncertain")
      lines.push(`  ${safeReviewDetail(event.detail)}`);
    else if (event.status === "unresolved")
      lines.push(`  ${displayUnresolvedDetail(event.detail)}`);
    else if (SAFE_REVIEW_OUTCOME_DETAILS.has(event.detail))
      lines.push(`  ${event.detail}`);
    const repair = /^Reassigned (\d{1,9}) duplicate memory ID\(s\)\./.exec(
      event.detail,
    );
    if (event.status === "repair" && repair)
      lines.push(`  Reassigned ${repair[1]} duplicate memory ID(s).`);
    if (event.review) {
      const count = (value: unknown) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
          ? String(value)
          : "unknown";
      const r = event.review;
      lines.push(`  Pages: ${count(r.pages)}; changes: ${event.changesTotal}`);
      if (r.resumedAtOffset)
        lines.push(`  Started at offset: ${count(r.resumedAtOffset)}`);
      if (r.evidenceGaps === undefined)
        lines.push("  Evidence coverage: unknown.");
      else
        lines.push(
          `  Evidence: ${count(r.evidenceGaps)} insufficient, ${count(r.limitedPages)} limited page(s). Discovery truncated: ${count(r.discoveryTruncatedPages)}; search incomplete: ${count(r.searchIncompletePages)}; candidates truncated: ${count(r.candidatesTruncatedPages)}. Coverage is not verification.`,
        );
      const diagnostics = formatReviewDiagnostics(r);
      if (diagnostics) lines.push(`  ${diagnostics}.`);
    } else if (event.changesTotal)
      lines.push(`  Changes: ${event.changesTotal}`);
    for (const change of event.changes)
      lines.push(
        `  - ${safeChangeText(change.detail) || "Change recorded (no description)"}`,
      );
    if (event.changesOmitted)
      lines.push(`  ${event.changesOmitted} change(s) omitted.`);
  }
  if (omittedEvents)
    lines.push(`${omittedEvents} recent run(s) omitted from this report.`);
  if (report.events.length + omittedEvents >= 20)
    lines.push("Older runs may have been removed from history.");
  return lines.join("\n");
}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export default function (pi: ExtensionAPI) {
  const managers = new Map<string, Promise<MemoryManager>>();
  const injectedSessions = new Set<string>();
  const warnedConflicts = new Map<string, string>();
  function warnDiagnostics(
    ctx: ExtensionContext,
    warnings: DuplicateIdWarning[],
  ): boolean {
    if (!warnings.length) {
      warnedConflicts.delete(ctx.cwd);
      return false;
    }
    const signature = JSON.stringify(
      warnings
        .map((warning) => [
          warning.id,
          warning.locations
            .map(({ category, line }) => `${category}:${line}`)
            .sort(),
        ])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
    if (warnedConflicts.get(ctx.cwd) !== signature) {
      warnedConflicts.set(ctx.cwd, signature);
      const details = warnings
        .map(
          (warning) =>
            `${warning.id} (${warning.locations.map(({ category, line }) => `.pi/memory/${category}.ndjson:${line}`).join(", ")})`,
        )
        .join("; ");
      const message = `Duplicate memory IDs: ${details}. ${DUPLICATE_REVIEW_GUIDANCE} Memory was not changed by this warning.`;
      try {
        if (ctx.hasUI && typeof ctx.ui.notify === "function")
          ctx.ui.notify(message, "warning");
        else console.error(message);
      } catch {
        console.error(message);
      }
    }
    return true;
  }
  function warnConflict(ctx: ExtensionContext, error: unknown): boolean {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith("Memory conflict: duplicate id ")
    )
      return false;
    if (warnedConflicts.get(ctx.cwd) !== error.message) {
      warnedConflicts.set(ctx.cwd, error.message);
      const message = `${error.message}. ${DUPLICATE_REVIEW_GUIDANCE} Memory was not changed by this operation.`;
      try {
        if (ctx.hasUI && typeof ctx.ui.notify === "function")
          ctx.ui.notify(message, "warning");
        else console.error(message);
      } catch {
        console.error(message);
      }
    }
    return true;
  }
  let scheduler: MemoryScheduler | undefined;
  let schedulerBoot: { activity(): void; stop(): Promise<void> } | undefined;
  let backgroundEnabled = false;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let feedbackUI: ExtensionContext["ui"] | undefined;
  let feedbackGeneration = 0;
  function showFeedback(ctx: ExtensionContext, status: string) {
    if (!ctx.hasUI || typeof ctx.ui.setStatus !== "function") return;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackUI = ctx.ui;
    try {
      ctx.ui.setStatus("memory-review", `Memory review: ${status}`);
    } catch {
      feedbackUI = undefined;
      return;
    }
    feedbackTimer = setTimeout(() => {
      feedbackTimer = undefined;
      try {
        feedbackUI?.setStatus("memory-review", undefined);
      } catch {}
      feedbackUI = undefined;
    }, 5000);
    feedbackTimer.unref();
  }

  function getManager(cwd: string): Promise<MemoryManager> {
    let manager = managers.get(cwd);
    if (!manager) {
      manager = Promise.resolve(new MemoryManager(cwd));
      managers.set(cwd, manager);
    }
    return manager;
  }

  async function getReadyManager(
    ctx: ExtensionContext,
  ): Promise<MemoryManager | undefined> {
    if (
      !(await isExtensionEnabled(ctx, CONFIG_DIR_NAME, MEMORY_EXTENSION_ID))
    ) {
      return undefined;
    }
    const ready = await getManager(ctx.cwd);
    return (await ready.isReady()) ? ready : undefined;
  }

  async function getReviewControl(
    ctx: ExtensionContext,
  ): Promise<MemoryScheduler | undefined> {
    if (!ctx.isProjectTrusted()) return undefined;
    const manager = await getReadyManager(ctx);
    if (!manager) return undefined;
    if (!scheduler && backgroundEnabled && schedulerBoot)
      throw new Error("review scheduler is starting; try again shortly");
    if (!scheduler) {
      const sessionDir = ctx.sessionManager?.getSessionDir?.() || ctx.cwd;
      scheduler = new MemoryScheduler({
        project: ctx.cwd,
        runtimeDir: join(
          ctx.cwd,
          CONFIG_DIR_NAME,
          "memory",
          ".runtime",
          "review-scheduler",
        ),
        sessionDir,
        automatic: false,
        // An on-demand control must not start history review when it was disabled.
        work: async () => ({ status: "pending" }),
        onStatus: (status) => showFeedback(ctx, status),
      });
    }
    return scheduler;
  }

  // Called only under the scheduler's shared project claim. Persist observation,
  // continuation invalidation and a visible event atomically, including recovery
  // receipts created by another process or an interrupted repair.
  async function observeDuplicateRepairs(
    manager: MemoryManager,
    cwd: string,
    mode: "manual" | "background",
    signal: AbortSignal,
  ) {
    await manager.resolveDuplicateIds(signal);
    const receipts = await manager.listDuplicateIdResolutions();
    const db = new Database(
      join(
        cwd,
        CONFIG_DIR_NAME,
        "memory",
        ".runtime",
        "review-scheduler",
        "scheduler.sqlite",
      ),
      { timeout: 0 },
    );
    try {
      db.exec(
        "CREATE TABLE IF NOT EXISTS duplicate_repair_observed (id TEXT PRIMARY KEY)",
      );
      return db.transaction(() => {
        const add = db.prepare(
          "INSERT OR IGNORE INTO duplicate_repair_observed(id) VALUES (?)",
        );
        const fresh = receipts.filter(
          (receipt) =>
            receipt.transactionId && add.run(receipt.transactionId).changes,
        );
        if (!fresh.length) return undefined;
        const changes = fresh.flatMap((receipt) => receipt.changes);
        const ids = changes
          .map((change) => change.newId)
          .filter((id) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
              id,
            ),
          );
        const shown = ids.slice(0, 5);
        const detail = `Reassigned ${changes.length} duplicate memory ID(s).${shown.length ? ` New IDs: ${shown.join(", ")}${changes.length > shown.length ? " (additional IDs omitted)" : ""}.` : ""}`;
        db.prepare("DELETE FROM manual_cursor WHERE id=1").run();
        db.prepare(
          "INSERT INTO review_events(at,mode,status,detail,changes,changes_total) VALUES (?,?,?,?,?,?)",
        ).run(Date.now(), mode, "repair", detail, "[]", 0);
        return detail;
      })();
    } finally {
      db.close();
    }
  }

  async function reviewOperation(
    action: "status" | "full" | "resume" | "cancel",
    ctx: ExtensionContext,
    signal?: AbortSignal,
    options?: { restart?: boolean },
  ) {
    if (!ctx.isProjectTrusted())
      return textResult("Memory review requires a trusted project.", {
        available: false,
      });
    let control: MemoryScheduler | undefined;
    try {
      const manager = await getReadyManager(ctx);
      if (!manager)
        return textResult(NOT_ENABLED_MESSAGE, { available: false });
      control = await getReviewControl(ctx);
      if (!control)
        return textResult("Memory review is unavailable.", {
          available: false,
        });
      if (action === "cancel") {
        const result = control.cancel();
        return textResult(
          result.mayContinue
            ? "Cancellation requested; in-flight work may still finish. Pending work remains paused; inspect before resuming."
            : "Memory review cancelled; pending work remains paused.",
          { action, ...result },
        );
      }
      if (action === "resume") {
        control.resume({ schedule: backgroundEnabled });
        return textResult(
          "Memory review resumed after explicit acknowledgement.",
          { action },
        );
      }
      if (action === "full") {
        const changes: Array<{ id: string; detail: string }> = [];
        const result = await control.runManual(
          async (runSignal, progress) => {
            try {
              runSignal.throwIfAborted();
              let repairDetail: string | undefined;
              try {
                repairDetail = await observeDuplicateRepairs(
                  manager,
                  ctx.cwd,
                  "manual",
                  runSignal,
                );
              } catch {
                return {
                  status: "uncertain",
                  detail:
                    "Duplicate ID repair may be incomplete; inspect memory files before resuming.",
                };
              }
              if (repairDetail) {
                changes.push({
                  id: "duplicate-id-repair",
                  detail: repairDetail,
                });
                progress.clear();
              }
              runSignal.throwIfAborted();
              const reviewer = await createConfiguredPiMemoryReviewer(
                ctx,
                createTrackedReviewStore(manager, changes),
                repairDetail ? undefined : progress.resumePermit,
              );
              const outcome = await reviewAllMemories({
                reviewer,
                signal: runSignal,
                fullOffset: progress.current?.offset,
                fullSnapshot: progress.current?.snapshot,
                priorEvidenceGaps: progress.current?.evidenceGaps,
                onProgress: (cursor) => {
                  if (cursor) progress.advance(cursor);
                  else progress.clear();
                },
              });
              return changes.length ? { ...outcome, changes } : outcome;
            } catch (error) {
              if (changes.length)
                return {
                  status: "uncertain",
                  detail:
                    "Review stopped after applying changes; inspect before retrying.",
                  changes,
                };
              throw error;
            }
          },
          signal,
          { restart: options?.restart },
        );
        const safeResult =
          result.status === "error" || result.status === "uncertain"
            ? { ...result, detail: safeReviewDetail(result.detail) }
            : result.status === "unresolved"
              ? {
                  ...result,
                  detail: displayUnresolvedDetail(result.detail ?? ""),
                }
              : result;
        const repair = safeResult.changes?.find(
          (change) => change.id === "duplicate-id-repair",
        );
        const review = safeResult.review;
        const summary = review
          ? ` This run evaluated ${review.pages} page(s)${review.resumedAtOffset ? ` starting at offset ${review.resumedAtOffset}` : ""}; ${safeResult.changes?.length ?? 0} change(s) recorded in this run. ${review.evidenceGaps === undefined ? "Evidence coverage is unknown." : `${review.evidenceGaps} page(s) reported insufficient evidence; ${review.limitedPages ?? 0} had limited coverage. Discovery was truncated on ${review.discoveryTruncatedPages ?? 0} page(s), search incomplete on ${review.searchIncompletePages ?? 0}, and cross-page candidates truncated on ${review.candidatesTruncatedPages ?? 0}. ${review.pages - review.evidenceGaps - (review.limitedPages ?? 0)} page evaluation(s) had no coverage metadata. Coverage is not verification.`}${review.resumedAtOffset ? " Earlier runs are listed separately in review status." : ""}`
          : "";
        const diagnostics = review ? formatReviewDiagnostics(review) : "";
        const detail =
          safeResult.status === "unresolved"
            ? displayUnresolvedDetail(safeResult.detail ?? "")
            : (safeResult.detail ?? "");
        const retry =
          safeResult.status === "unresolved"
            ? " Run /memory-review full again to retry; evidence gaps or conflicts may remain."
            : "";
        const text = `Full memory review ${safeResult.status}: ${detail}${retry}${summary}${diagnostics ? ` ${diagnostics}.` : ""}${repair ? ` ${repair.detail}` : ""}${safeResult.nextOffset === undefined ? "" : ` Progress saved at offset ${safeResult.nextOffset}; run /memory-review full to continue.`}`;
        return textResult(text, { action, result: safeResult });
      }
      const settings = await getRuntimeSettings(ctx, CONFIG_DIR_NAME);
      const raw = control.report();
      const report = {
        status: raw.status,
        eventScope:
          "Each event covers one run, not the cumulative review; older runs may be omitted.",
        configuredModel:
          getSettingValue<string>(
            settings,
            MEMORY_EXTENSION_ID,
            "models.reviewer",
          ) || null,
        historyEnabled:
          getSettingValue<boolean>(
            settings,
            MEMORY_EXTENSION_ID,
            "historyReview.enabled",
          ) === true,
        events: raw.events.slice(0, 8).map((event) => ({
          ...event,
          detail:
            event.status === "error" || event.status === "uncertain"
              ? safeReviewDetail(event.detail)
              : event.status === "unresolved"
                ? displayUnresolvedDetail(event.detail)
                : event.detail.slice(0, 400),
          changes: event.changes.slice(0, 5).map((change) => ({
            ...change,
            detail: change.detail.slice(0, 150),
          })),
          changesOmitted: Math.max(
            0,
            event.changesTotal - Math.min(5, event.changes.length),
          ),
        })),
      };
      return textResult(
        formatReviewStatus(
          report,
          Math.max(0, raw.events.length - report.events.length),
        ),
        { action, report },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "project review is active"
      )
        return textResult(
          "Memory review is already active. Wait for it to finish, then try again.",
          { action, active: true },
        );
      const detail = safeReviewDetail(
        error instanceof Error ? error.message : undefined,
      );
      if (action === "full" && control) {
        try {
          control.noteManualFailure(detail);
        } catch {}
      }
      return textResult(`Memory review ${action} failed: ${detail}`, {
        action,
        failed: true,
      });
    }
  }

  async function injectMemoryMessage(ctx: ExtensionContext) {
    const manager = await getReadyManager(ctx);
    if (!manager) return;
    const promptContext = await manager.buildPromptContext();
    warnDiagnostics(ctx, manager.getWarnings());
    if (!promptContext) return null;
    return {
      message: {
        customType: "project_memory",
        content: `Project memory:\n${promptContext}`,
        display: false,
      },
    };
  }

  publishExtensionSettings(pi.events, {
    id: MEMORY_EXTENSION_ID,
    label: "Project Memory",
    description:
      "Enables project memory tools and automatic memory-context injection.",
    fields: {
      enabled: {
        type: "boolean",
        default: true,
        label: "Enabled",
      },
      "historyReview.enabled": {
        type: "boolean",
        default: true,
        label: "Review session history",
        description:
          "When enabled, background review sends project session text and selected repository excerpts to the explicitly configured reviewer model provider.",
      },
      "historyReview.debounceSeconds": {
        type: "number",
        default: 30,
        minimum: 0,
        maximum: 3600,
        integer: true,
        label: "Review debounce seconds",
      },
      "historyReview.cooldownSeconds": {
        type: "number",
        default: 300,
        minimum: 0,
        maximum: 86400,
        integer: true,
        label: "Review cooldown seconds",
      },
      "models.reviewer": {
        type: "string",
        default: "",
        label: "Memory reviewer model",
        description:
          "Explicit provider/model for memory review. Selected session text and repository evidence may be sent to this provider; empty disables review.",
        selectValues: (context) => [
          ...new Set(
            (context.scopedModels.length
              ? context.scopedModels.map(({ model }) => model)
              : context.modelRegistry.getAvailable()
            ).map((model) => `${model.provider}/${model.id}`),
          ),
        ],
      },
    },
    toolNames: MEMORY_TOOL_NAMES,
  });

  pi.on("session_start", async (_event, ctx) => {
    removeDisabledTools(
      pi,
      MEMORY_TOOL_NAMES,
      await isExtensionEnabled(ctx, CONFIG_DIR_NAME, MEMORY_EXTENSION_ID),
    );
    if (!ctx.isProjectTrusted()) return;
    const settings = await getRuntimeSettings(ctx, CONFIG_DIR_NAME);
    if (
      getSettingValue<boolean>(settings, MEMORY_EXTENSION_ID, "enabled") ===
        false ||
      getSettingValue<boolean>(
        settings,
        MEMORY_EXTENSION_ID,
        "historyReview.enabled",
      ) !== true ||
      !getSettingValue<string>(
        settings,
        MEMORY_EXTENSION_ID,
        "models.reviewer",
      )?.trim()
    )
      return;
    const configuredDir = ctx.sessionManager?.getSessionDir?.();
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    if (!sessionFile) return; // Ephemeral sessions cannot be discovered or resumed.
    const sessionDir = dirname(resolve(sessionFile));
    // SessionReview discovers JSONL only. Persist an explicit unavailable source
    // so an active custom filename cannot be silently marked complete.
    const unsupportedFile =
      extname(sessionFile) === ".jsonl"
        ? undefined
        : `${UNSUPPORTED_FILE_SOURCE}${resolve(sessionFile)}`;
    const isWorkerDir = (dir: string) => {
      const workerRelative = relative(
        resolve(ctx.cwd, "tmp/subagents"),
        resolve(dir),
      );
      return (
        workerRelative === "" ||
        (workerRelative !== ".." &&
          !workerRelative.startsWith(`..${sep}`) &&
          !isAbsolute(workerRelative))
      );
    };
    if (
      isWorkerDir(sessionDir) ||
      (configuredDir && isWorkerDir(configuredDir))
    )
      return;
    const manager = await getReadyManager(ctx);
    if (!manager) return;
    const runtimeDir = join(
      ctx.cwd,
      CONFIG_DIR_NAME,
      "memory",
      ".runtime",
      "review-scheduler",
    );
    backgroundEnabled = true;
    const schedulerOptions: SchedulerOptions = {
      project: ctx.cwd,
      runtimeDir,
      sessionDir,
      additionalSessionDirs: configuredDir ? [configuredDir] : [],
      additionalSources: unsupportedFile ? [unsupportedFile] : [],
      debounceMs:
        (getSettingValue<number>(
          settings,
          MEMORY_EXTENSION_ID,
          "historyReview.debounceSeconds",
        ) ?? 30) * 1000,
      cooldownMs:
        (getSettingValue<number>(
          settings,
          MEMORY_EXTENSION_ID,
          "historyReview.cooldownSeconds",
        ) ?? 300) * 1000,
      work: async (directory, signal) => {
        const current = await getRuntimeSettings(ctx, CONFIG_DIR_NAME);
        if (
          !ctx.isProjectTrusted() ||
          getSettingValue<boolean>(current, MEMORY_EXTENSION_ID, "enabled") ===
            false ||
          getSettingValue<boolean>(
            current,
            MEMORY_EXTENSION_ID,
            "historyReview.enabled",
          ) !== true ||
          !getSettingValue<string>(
            current,
            MEMORY_EXTENSION_ID,
            "models.reviewer",
          )?.trim()
        )
          return { status: "pending" };
        signal.throwIfAborted();
        const changes: Array<{ id: string; detail: string }> = [];
        let repairDetail: string | undefined;
        try {
          repairDetail = await observeDuplicateRepairs(
            manager,
            ctx.cwd,
            "background",
            signal,
          );
        } catch {
          return {
            status: "uncertain",
            detail:
              "Duplicate ID repair may be incomplete; inspect memory files before resuming.",
          };
        }
        if (repairDetail) {
          changes.push({ id: "duplicate-id-repair", detail: repairDetail });
          if (ctx.hasUI) {
            try {
              ctx.ui.notify(repairDetail, "info");
            } catch {}
          }
        }
        try {
          signal.throwIfAborted();
          if (directory.startsWith(UNSUPPORTED_FILE_SOURCE))
            return {
              status: "unsupported-session",
              detail:
                "The explicitly opened session filename is not JSONL; activity remains pending.",
              ...(changes.length ? { changes } : {}),
            };
          const reviewer = await createConfiguredPiMemoryReviewer(
            ctx,
            createTrackedReviewStore(manager, changes),
          );
          const outcome = await reviewProjectSessions({
            project: ctx.cwd,
            sessionDir: directory,
            checkpointFile: join(runtimeDir, "session-progress.json"),
            reviewer,
            signal,
          });
          return changes.length ? { ...outcome, changes } : outcome;
        } catch (error) {
          if (changes.length)
            return {
              status: "uncertain",
              detail:
                "Review stopped after applying changes; inspect before retrying.",
              changes,
            };
          throw error;
        }
      },
      onStatus: (status: string) => showFeedback(ctx, status),
    };
    // SQLite initialization can encounter a project writer. Retry without blocking
    // the lifecycle hook; activity is spooled independently while initialization waits.
    let stopped = false,
      pending = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let writing: Promise<void> | undefined;
    const scheduleRetry = () => {
      if (stopped || retry) return;
      retry = setTimeout(() => {
        retry = undefined;
        initialize();
        if (pending) flush();
      }, 1000);
      retry.unref();
    };
    const flush = () => {
      if (writing || !pending) return;
      writing = (async () => {
        while (pending) {
          pending = false;
          try {
            await persistSchedulerActivity(runtimeDir, [
              sessionDir,
              ...(configuredDir ? [configuredDir] : []),
              ...(unsupportedFile ? [unsupportedFile] : []),
            ]);
          } catch {
            pending = true;
            console.error(
              "Memory review activity could not be persisted; retry is pending.",
            );
            scheduleRetry();
            break;
          }
        }
        scheduler?.start();
      })().finally(() => {
        writing = undefined;
        if (pending) scheduleRetry();
      });
    };
    const initialize = () => {
      if (stopped || scheduler) return;
      try {
        scheduler = new MemoryScheduler(schedulerOptions);
        scheduler.start();
      } catch {
        console.error("Memory review scheduler unavailable; retry is pending.");
        scheduleRetry();
      }
    };
    schedulerBoot = {
      activity() {
        pending = true;
        flush();
      },
      async stop() {
        stopped = true;
        if (retry) clearTimeout(retry);
        if (pending && !writing) flush();
        if (writing) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            writing,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 1000);
            }),
          ]);
          if (timer) clearTimeout(timer);
        }
        if (pending)
          console.error(
            "Memory review shutdown could not persist pending activity.",
          );
      },
    };
    initialize();
  });

  pi.on("agent_settled", () => {
    if (!backgroundEnabled) return;
    const active = scheduler;
    if (!active) {
      schedulerBoot?.activity();
      return;
    }
    if (active)
      void Promise.resolve()
        .then(() => active.activity())
        .catch(() => {
          // The scheduler retains the signal and retries; expose failure rather than dropping it.
          console.error(
            "Memory review activity could not yet be persisted; retry is pending.",
          );
        });
  });

  pi.on("session_shutdown", async () => {
    backgroundEnabled = false;
    feedbackGeneration++;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = undefined;
    try {
      feedbackUI?.setStatus("memory-review", undefined);
    } catch {}
    feedbackUI = undefined;
    const active = scheduler;
    scheduler = undefined;
    const boot = schedulerBoot;
    schedulerBoot = undefined;
    await boot?.stop();
    const result = await active?.shutdown();
    const entries = [...managers.values()];
    managers.clear();
    const closeManagers = async () => {
      for (const entry of entries) {
        const manager = await entry;
        await manager.close();
      }
    };
    if (result?.status === "quarantined" && active) {
      // The claim and manager remain owned until an abort-ignoring operation settles.
      void active
        .waitForIdle()
        .finally(closeManagers)
        .catch(() => {});
    } else {
      if (result?.status === "activity-unpersisted")
        console.error(
          "Memory review shutdown could not persist pending activity.",
        );
      await closeManagers();
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (injectedSessions.has(sessionId)) {
      return;
    }

    let result: Awaited<ReturnType<typeof injectMemoryMessage>>;
    try {
      result = await injectMemoryMessage(ctx);
    } catch (error) {
      if (!warnConflict(ctx, error)) throw error;
      return;
    }
    if (result !== undefined) {
      injectedSessions.add(sessionId);
    }
    return result ?? undefined;
  });

  pi.on("session_compact", async (_event, ctx) => {
    // The message may have been summarized away; reinject for this session.
    injectedSessions.delete(ctx.sessionManager.getSessionId());
  });

  pi.registerTool({
    name: "memory_remember",
    label: "Memory Remember",
    description:
      "Store a new project memory in NDJSON and sync the local index.",
    promptSnippet: "Store durable project knowledge, practices, or decisions",
    promptGuidelines: [
      "Use memory_remember proactively, without waiting for the user to ask, whenever the conversation establishes a reusable project fact.",
      "Compress each memory into one terse, self-contained sentence. Do not include rationale, examples, or prose.",
      "Do not include session-specific context such as turn numbers, option labels like 'Option A', timestamps, or references to the current conversation.",
      "Encode as knowledge when the fact describes what the codebase is: tech stack, dependencies, directory layout, external APIs, or build/test commands.",
      "Encode as practices when the fact describes how the codebase works: naming conventions, coding patterns, test style, file organization, or repeated workflows.",
      "Encode as decisions when the fact explains why a choice was made: architecture tradeoffs, rejected alternatives, scope boundaries, or library selection rationale.",
      "Choose the most specific memory_remember category: knowledge, practices, or decisions.",
      "After writing a memory, continue the task without asking the user for confirmation.",
    ],
    parameters: Type.Object({
      category: Type.Union(
        MEMORY_CATEGORIES.map((entry) => Type.Literal(entry)),
        { description: "Destination category file" },
      ),
      content: Type.String({
        description: "The memory content to store",
      }),
    }),
    renderResult(result, _options, theme) {
      const first = result.content[0];
      const confirmation =
        first?.type === "text" ? first.text : "Memory result completed.";
      const details = isRememberResultDetails(result.details)
        ? result.details
        : undefined;
      if (!details) return new Text(theme.fg("dim", confirmation), 0, 0);

      return new Text(
        [
          theme.fg("dim", confirmation),
          theme.fg("accent", `${details.category} memory`),
          details.content,
        ].join("\n"),
        0,
        0,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getReadyManager(ctx);
      if (!manager) return textResult(NOT_ENABLED_MESSAGE, { enabled: false });

      const result = await manager.remember(params.category, params.content);
      return textResult(
        result.created
          ? `Stored ${params.category} memory.`
          : `Matching ${params.category} memory already exists.`,
        {
          kind: "memory_remember",
          category: params.category,
          content: result.memory.content,
          id: result.memory.id,
          created: result.created,
        } satisfies RememberResultDetails,
      );
    },
  });

  pi.registerTool({
    name: "memory_recall",
    label: "Memory Recall",
    description:
      "Retrieve relevant project memories using local semantic search with fallbacks.",
    promptSnippet: "Retrieve relevant project memories before acting",
    promptGuidelines: [
      "Use memory_recall when the user asks about project conventions, history, architecture, or why something is the way it is.",
      "Use memory_recall before changing project patterns, conventions, file organization, or architecture to check for existing guidance.",
      "Use memory_recall's category parameter only when the query is clearly about knowledge, practices, or decisions.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      category: Type.Optional(
        Type.Union(MEMORY_CATEGORIES.map((entry) => Type.Literal(entry))),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum number of results to return",
          minimum: 1,
          maximum: 20,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getReadyManager(ctx);
      if (!manager) return textResult(NOT_ENABLED_MESSAGE, { enabled: false });

      const result = await manager.recall({
        query: params.query,
        category: params.category,
        limit: params.limit,
      });
      warnDiagnostics(ctx, result.warnings ?? []);
      return textResult(formatRecall(result), {
        searchMode: result.searchMode,
        memoryCount: result.memories.length,
        warnings: (result.warnings ?? []).map((warning) => ({
          ...warning,
          message: formatDuplicateWarning(warning),
        })),
      });
    },
  });

  pi.registerTool({
    name: "memory_update",
    label: "Memory Update",
    description:
      "Replace the content of an existing memory by id and resync the local index.",
    parameters: Type.Object({
      id: Type.String({ description: "Memory id to update" }),
      content: Type.String({ description: "New memory content" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getReadyManager(ctx);
      if (!manager) return textResult(NOT_ENABLED_MESSAGE, { enabled: false });

      const updated = await manager.update(params.id, params.content);
      if (!updated) {
        return textResult(`No memory found with id ${params.id}.`, {
          updated: false,
        });
      }

      return textResult(`Updated memory ${updated.id}.`, {
        updated: true,
        id: updated.id,
      });
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description:
      "Remove a memory from the NDJSON source of truth and local search index.",
    parameters: Type.Object({
      id: Type.String({ description: "Memory id to remove" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getReadyManager(ctx);
      if (!manager) return textResult(NOT_ENABLED_MESSAGE, { enabled: false });

      const removed = await manager.forget(params.id);
      if (!removed) {
        return textResult(`No memory found with id ${params.id}.`, {
          removed: false,
        });
      }

      return textResult(`Removed memory ${removed.id}.`, {
        removed: true,
        id: removed.id,
      });
    },
  });

  // Lifecycle / review tools are intentionally NOT given promptSnippet or
  // promptGuidelines. They should only be used when the user explicitly asks
  // for memory initialization, session review, or consolidation.

  pi.registerTool({
    name: "memory_init",
    label: "Memory Init",
    description:
      "Bootstrap .pi/memory NDJSON files, then build the local search index. Optionally seed initial knowledge/practices, or force-rebuild the index from the NDJSON source of truth.",
    parameters: Type.Object({
      seed: Type.Optional(
        Type.Boolean({
          description:
            "Scan the project and auto-seed initial knowledge and practices",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "Rebuild the vector and FTS search index from scratch",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (
        !(await isExtensionEnabled(ctx, CONFIG_DIR_NAME, MEMORY_EXTENSION_ID))
      ) {
        return textResult(NOT_ENABLED_MESSAGE, { enabled: false });
      }
      const manager = await getManager(ctx.cwd);
      const result = await manager.init(
        Boolean(params.force),
        Boolean(params.seed),
      );
      const seedText = params.seed
        ? ` created ${result.createdMemories}, skipped ${result.skippedMemories},`
        : "";
      const forceText = params.force ? " (rebuilt index)" : "";
      const recoveryText =
        result.recoveredLines > 0
          ? ` Removed ${result.recoveredLines} malformed NDJSON line${result.recoveredLines === 1 ? "" : "s"}.`
          : "";
      return textResult(
        `Initialized memory${forceText}.${seedText}${recoveryText} Semantic ${result.semanticEnabled ? "enabled" : "fallback-only"}.`,
        result,
      );
    },
  });

  pi.registerTool({
    name: "memory_repair",
    label: "Memory Repair",
    description:
      "Remove malformed NDJSON lines while retaining valid memories, then resync the local index.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const manager = await getReadyManager(ctx);
      if (!manager) return textResult(NOT_ENABLED_MESSAGE, { enabled: false });

      const result = await manager.repair();
      const detail = MEMORY_CATEGORIES.map(
        (category) => `${category}=${result.removedLines[category]}`,
      ).join(", ");
      return textResult(
        result.totalRemovedLines > 0
          ? `Removed ${result.totalRemovedLines} malformed NDJSON line${result.totalRemovedLines === 1 ? "" : "s"} (${detail}) and resynced the index.`
          : "No malformed NDJSON lines found.",
        result,
      );
    },
  });

  pi.registerTool({
    name: "memory_learn",
    label: "Memory Learn",
    description:
      "Review recent activity and suggest new memories without writing them.",
    parameters: Type.Object({
      since: Type.Optional(
        Type.String({
          description: "ISO timestamp lower bound for activity review",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getReadyManager(ctx);
      if (!manager) return textResult(NOT_ENABLED_MESSAGE, { enabled: false });

      const snippets = await manager.learn(params.since);
      return textResult(
        snippets.length > 0
          ? `Recent conversations from ${snippets.filter((s) => s.startsWith("--- Session")).length} sessions:\n\n${snippets.join("\n")}`
          : "No recent sessions found. Use `memory_remember` to add memories manually.",
        {
          sessionCount: snippets.filter((s) => s.startsWith("--- Session"))
            .length,
        },
      );
    },
  });

  pi.registerTool({
    name: "memory_consolidate",
    label: "Memory Consolidate",
    description:
      "Run an explicit evidence-based full memory review; supported changes may be applied automatically.",
    parameters: Type.Object({
      since: Type.Optional(
        Type.String({
          description:
            "Legacy option; date-limited reviews are not supported. Omit for a full review.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.since)
        return textResult(
          "Date-limited consolidation is no longer supported; omit since to run a full review.",
          { failed: true },
        );
      return reviewOperation("full", ctx, signal);
    },
  });

  // The tool is also available in headless/RPC mode; the command is a direct
  // user-facing entry point and never opens a focus-stealing screen.
  pi.registerCommand?.("memory-review", {
    description: "Show memory review status or request full, resume, or cancel",
    handler: async (args, ctx) => {
      const [actionText = "status", ...rest] = args
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const action = actionText as "status" | "full" | "resume" | "cancel";
      const restart =
        action === "full" && rest.length === 1 && rest[0] === "--restart";
      if (
        !["status", "full", "resume", "cancel"].includes(action) ||
        (rest.length > 0 && !restart)
      ) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Usage: /memory-review [status|full [--restart]|resume|cancel]",
            "warning",
          );
        return;
      }
      if (action === "full") {
        const target = ctx.ui;
        const generation = feedbackGeneration;
        void reviewOperation(action, ctx, undefined, { restart })
          .then((result) => {
            if (ctx.hasUI && generation === feedbackGeneration)
              target.notify(result.content[0].text, "info");
          })
          .catch(() => {
            if (ctx.hasUI && generation === feedbackGeneration)
              target.notify(
                `Full memory review failed: ${safeReviewDetail(undefined)}`,
                "error",
              );
          });
        return;
      }
      const result = await reviewOperation(action, ctx);
      if (ctx.hasUI) ctx.ui.notify(result.content[0].text, "info");
    },
  });

  pi.registerTool({
    name: "memory_review",
    label: "Memory Review",
    description:
      "Inspect bounded memory review status and reports, run a full review, or explicitly resume/cancel pending work.",
    parameters: Type.Object({
      restart: Type.Optional(
        Type.Boolean({
          description:
            "Explicitly discard saved full-review progress and start from the first page.",
        }),
      ),
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("full"),
        Type.Literal("resume"),
        Type.Literal("cancel"),
      ]),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.restart && params.action !== "full")
        return textResult("restart is available only for a full review.", {
          failed: true,
        });
      return reviewOperation(params.action, ctx, signal, {
        restart: params.restart,
      });
    },
  });

  pi.registerTool({
    name: "memory_list",
    label: "Memory List",
    description: "List stored memories and category counts.",
    promptSnippet: "Audit stored project memories",
    promptGuidelines: [
      "Use memory_list when the user asks what the project remembers, or before consolidating/updating memories.",
    ],
    parameters: Type.Object({
      category: Type.Optional(
        Type.String({
          description: "Optional category filter",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getReadyManager(ctx);
      if (!manager) return textResult(NOT_ENABLED_MESSAGE, { enabled: false });

      const { memories, counts } = await manager.list();
      const filtered = isMemoryCategory(params.category)
        ? memories.filter((memory) => memory.category === params.category)
        : memories;

      const header = `Counts: knowledge=${counts.knowledge}, practices=${counts.practices}, decisions=${counts.decisions}`;
      if (filtered.length === 0) {
        return textResult(`${header}\n\nNo stored memories.`);
      }

      const body = filtered
        .map(
          (memory) =>
            `- [${memory.category}] ${memory.id.slice(0, 8)} ${memory.content}`,
        )
        .join("\n");
      return textResult(`${header}\n\n${body}`, { count: filtered.length });
    },
  });
}
