import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  CompletionInbox,
  type CompletionInboxRecord,
} from "./completion-inbox.ts";
import { type WorkstreamManifest, WorkstreamSupervisor } from "./supervisor.ts";

const MAX_WAIT_RESULT_CHARS = 7_200;

const WaitParameters = Type.Object({
  workstreamIds: Type.Optional(
    Type.Array(
      Type.String({
        description: "An actionable task-worker or research-job workstream ID.",
        minLength: 1,
      }),
      {
        description:
          "Live or paused workers to wait for. Omit to snapshot every actionable worker now.",
        minItems: 1,
      },
    ),
  ),
});

export type SubagentWaitFailure = {
  workstreamId: string;
  status: "failed";
  detail: string;
};

export type SubagentWaitResult = {
  workstreamIds: string[];
  reports: CompletionInboxRecord[];
  failures: SubagentWaitFailure[];
};

export class SubagentWaitService {
  private readonly supervisor: WorkstreamSupervisor;
  private readonly inbox: CompletionInbox;
  private readonly onConsumed?: (
    reports: readonly CompletionInboxRecord[],
  ) => Promise<void> | void;

  constructor(
    supervisor: WorkstreamSupervisor,
    inbox: CompletionInbox,
    onConsumed?: (
      reports: readonly CompletionInboxRecord[],
    ) => Promise<void> | void,
  ) {
    this.supervisor = supervisor;
    this.inbox = inbox;
    this.onConsumed = onConsumed;
  }

  async wait(
    workstreamIds: string[] | undefined,
    signal?: AbortSignal,
  ): Promise<SubagentWaitResult> {
    throwIfAborted(signal);
    const snapshot = await this.snapshot(workstreamIds);
    await this.waitForActionable(snapshot, signal);

    const manifests = await this.current(snapshot);
    const actionable = manifests.filter(isWaitOutcome);
    const failures = actionable.filter(isFailed).map(toWaitFailure);
    throwIfAborted(signal);
    const records = await this.inbox.list();
    throwIfAborted(signal);
    const reports = actionable.filter(isReportTerminal).map((manifest) => {
      const report = records
        .filter(
          (record) =>
            record.workstreamId === manifest.id &&
            record.deliveryState !== "consumed",
        )
        .at(-1);
      if (!report) {
        throw new Error(
          `Subagent workstream '${manifest.id}' ${manifest.status} without a retained completion report.`,
        );
      }
      return report;
    });

    // Once every selected worker has a retained report, the wait itself is
    // complete. Consumption is deliberately not cancellation-aware: a parent
    // cancellation while workers are still running returns before this point,
    // while a completed wait must atomically claim its reports from later
    // next-turn inbox delivery.
    const consumed = await this.inbox.consume(
      reports.map((report) => report.id),
    );
    if (consumed.length !== reports.length) {
      throw new Error(
        "A completion report was already consumed by another wait.",
      );
    }
    await this.onConsumed?.(consumed);
    return {
      workstreamIds: actionable.map((manifest) => manifest.id),
      reports: consumed,
      failures,
    };
  }

  private async waitForActionable(
    snapshot: readonly WorkstreamManifest[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const pending = new Map(
      snapshot
        .filter((manifest) => manifest.status !== "paused")
        .map((manifest) => [
          manifest.id,
          this.supervisor
            .waitForSettlement(manifest.id)
            .then(() => manifest.id),
        ]),
    );
    while (true) {
      throwIfAborted(signal);
      const manifests = await this.current(snapshot);
      if (manifests.some(isWaitOutcome)) return;
      for (const manifest of manifests) {
        if (manifest.status === "cancelled") pending.delete(manifest.id);
      }
      if (pending.size === 0) return;
      const settledId = await waitWithCancellation(
        Promise.race(pending.values()),
        signal,
      );
      pending.delete(settledId);
    }
  }

  private async current(
    snapshot: readonly WorkstreamManifest[],
  ): Promise<WorkstreamManifest[]> {
    return Promise.all(
      snapshot.map(async ({ id }) => {
        const manifest = await this.supervisor.get(id);
        if (!manifest) throw new Error(`Unknown subagent workstream '${id}'.`);
        return manifest;
      }),
    );
  }

  private async snapshot(
    workstreamIds: string[] | undefined,
  ): Promise<WorkstreamManifest[]> {
    if (workstreamIds?.length === 0) {
      throw new Error(
        "subagent_wait workstreamIds must include at least one actionable workstream ID.",
      );
    }
    if (workstreamIds && new Set(workstreamIds).size !== workstreamIds.length) {
      throw new Error(
        "subagent_wait workstreamIds must not contain duplicates.",
      );
    }
    const manifests = workstreamIds
      ? await Promise.all(
          workstreamIds.map(async (id) => {
            const manifest = await this.supervisor.get(id);
            if (!manifest)
              throw new Error(`Unknown subagent workstream '${id}'.`);
            return manifest;
          }),
        )
      : await this.supervisor.list();
    const snapshot: WorkstreamManifest[] = [];
    for (const listed of manifests) {
      const live = await this.supervisor.isLive(listed.id);
      // A worker can settle after the manifest listing or inbox scan but before
      // its liveness check. Re-read its manifest and inbox after that check so
      // an implicit wait does not lose the completion and keep waiting on an
      // unrelated snapshot worker.
      const manifest = live
        ? listed
        : ((await this.supervisor.get(listed.id)) ?? listed);
      const reportReady = isReportTerminal(manifest)
        ? (await this.inbox.listUnconsumed()).some(
            (report) => report.workstreamId === manifest.id,
          )
        : false;
      const wasLiveWhenListed =
        listed.status === "starting" || listed.status === "running";
      if (
        manifest.status === "paused" ||
        manifest.status === "failed" ||
        reportReady ||
        live ||
        wasLiveWhenListed
      ) {
        snapshot.push(manifest);
        continue;
      }
      if (workstreamIds) {
        throw new Error(
          `Subagent workstream '${manifest.id}' is ${manifest.status}, not live, paused, failed, or report-ready; subagent_wait only accepts actionable workstreams.`,
        );
      }
    }
    return snapshot;
  }
}

export function registerSubagentWaitTool(
  pi: ExtensionAPI,
  getService: () => SubagentWaitService | undefined,
): void {
  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for subagents",
    description:
      "Deliberately wait for selected actionable workstreams, or every actionable workstream now, and return ready reports and failure details without waking or interrupting the parent later.",
    parameters: WaitParameters,
    renderShell: "self",
    renderCall() {
      return new Text("", 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial || isInterruptedWaitResult(result.details)) {
        return new Text("", 0, 0);
      }
      const report = result.content.find((content) => content.type === "text");
      return new Text(
        report?.type === "text" ? theme.fg("toolOutput", report.text) : "",
        0,
        0,
      );
    },
    async execute(_toolCallId, params, signal) {
      const service = getService();
      if (!service) return unavailable();
      try {
        const result = await service.wait(params.workstreamIds, signal);
        return {
          content: [{ type: "text", text: formatWaitResult(result) }],
          details: {
            workstreamIds: result.workstreamIds,
            reports: result.reports.map((report) => ({
              workstreamId: report.workstreamId,
              kind: report.kind,
              terminalStatus: report.terminalStatus,
              artifactReferences: report.artifactReferences,
            })),
            failures: result.failures,
          },
        };
      } catch (error) {
        return error instanceof WaitCancelledError
          ? interruptedWaitResult()
          : toolError(error);
      }
    },
  });
}

function isReportTerminal(manifest: WorkstreamManifest): boolean {
  return (
    manifest.status === "settled" ||
    manifest.status === "blocked" ||
    manifest.status === "needs_decision"
  );
}

function isWaitOutcome(manifest: WorkstreamManifest): boolean {
  return (
    manifest.status === "paused" ||
    manifest.status === "failed" ||
    isReportTerminal(manifest)
  );
}

function isFailed(manifest: WorkstreamManifest): boolean {
  return manifest.status === "failed";
}

function toWaitFailure(manifest: WorkstreamManifest): SubagentWaitFailure {
  return {
    workstreamId: manifest.id,
    status: "failed",
    detail: manifest.failure ?? "Worker session failed.",
  };
}

export function formatWaitResult(result: SubagentWaitResult): string {
  const reportIds = new Set(
    result.reports.map((report) => report.workstreamId),
  );
  const failureIds = new Set(
    result.failures.map((failure) => failure.workstreamId),
  );
  const pausedIds = result.workstreamIds.filter(
    (id) => !reportIds.has(id) && !failureIds.has(id),
  );
  const sections = [
    ...(result.reports.length > 0
      ? [
          "Waited worker reports:",
          ...result.reports.map((report) => report.handoff),
        ]
      : []),
    ...result.failures.map(
      (failure) =>
        `Failed subagent workstream '${failure.workstreamId}': ${failure.detail}`,
    ),
    ...(pausedIds.length > 0
      ? [
          `Paused subagent workstreams require explicit resume: ${pausedIds.join(", ")}.`,
        ]
      : []),
  ];
  return (
    sections.length > 0
      ? sections.join("\n\n")
      : "No live subagent workers were present in this wait snapshot."
  ).slice(0, MAX_WAIT_RESULT_CHARS);
}

function waitWithCancellation<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new WaitCancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new WaitCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WaitCancelledError();
}

class WaitCancelledError extends Error {
  constructor() {
    super(
      "subagent_wait was cancelled; workers and completion records were left unchanged.",
    );
  }
}

function isInterruptedWaitResult(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { interrupted?: unknown }).interrupted === true
  );
}

function interruptedWaitResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: "Wait interrupted; workers and completion records were left unchanged.",
      },
    ],
    isError: false,
    terminate: true,
    details: {
      interrupted: true,
      workersAndInboxUnchanged: true,
    },
  };
}

function unavailable() {
  return {
    content: [
      {
        type: "text" as const,
        text: "Subagent workers are unavailable because this session is not a trusted, enabled subagent session.",
      },
    ],
    isError: true,
    details: {},
  };
}

function toolError(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
    details: {},
  };
}
