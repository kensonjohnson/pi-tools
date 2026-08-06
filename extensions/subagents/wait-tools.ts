import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
        description: "A live task-worker or research-job workstream ID.",
        minLength: 1,
      }),
      {
        description:
          "Live workers to wait for. Omit to snapshot every live worker now.",
        minItems: 1,
      },
    ),
  ),
});

export type SubagentWaitResult = {
  workstreamIds: string[];
  reports: CompletionInboxRecord[];
};

export class SubagentWaitService {
  private readonly supervisor: WorkstreamSupervisor;
  private readonly inbox: CompletionInbox;

  constructor(supervisor: WorkstreamSupervisor, inbox: CompletionInbox) {
    this.supervisor = supervisor;
    this.inbox = inbox;
  }

  async wait(
    workstreamIds: string[] | undefined,
    signal?: AbortSignal,
  ): Promise<SubagentWaitResult> {
    const snapshot = await this.snapshot(workstreamIds);
    throwIfAborted(signal);
    await waitWithCancellation(
      Promise.all(
        snapshot.map((workstream) =>
          this.supervisor.waitForSettlement(workstream.id),
        ),
      ),
      signal,
    );

    const manifests = await Promise.all(
      snapshot.map(async ({ id }) => {
        const manifest = await this.supervisor.get(id);
        if (!manifest) throw new Error(`Unknown subagent workstream '${id}'.`);
        return manifest;
      }),
    );
    const failures = manifests.filter(
      (manifest) => !isReportTerminal(manifest),
    );
    if (failures.length > 0) {
      throw new Error(
        failures.map((manifest) => terminalError(manifest)).join(" "),
      );
    }

    throwIfAborted(signal);
    const records = await this.inbox.list();
    throwIfAborted(signal);
    const reports = manifests.map((manifest) => {
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
    return {
      workstreamIds: manifests.map((manifest) => manifest.id),
      reports: consumed,
    };
  }

  private async snapshot(
    workstreamIds: string[] | undefined,
  ): Promise<WorkstreamManifest[]> {
    if (workstreamIds?.length === 0) {
      throw new Error(
        "subagent_wait workstreamIds must include at least one live workstream ID.",
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
    for (const manifest of manifests) {
      if (!(await this.supervisor.isLive(manifest.id))) {
        if (workstreamIds) {
          throw new Error(
            `Subagent workstream '${manifest.id}' is ${manifest.status}, not live; subagent_wait only accepts live workstreams.`,
          );
        }
        continue;
      }
      snapshot.push(manifest);
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
      "Deliberately wait for selected live workers, or every worker live now, and return their bounded terminal reports without waking or interrupting the parent later.",
    parameters: WaitParameters,
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
          },
        };
      } catch (error) {
        return toolError(error);
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

function terminalError(manifest: WorkstreamManifest): string {
  const detail = manifest.failure ? `: ${manifest.failure}` : "";
  return `Subagent workstream '${manifest.id}' ended ${manifest.status}${detail}; no terminal completion report is available.`;
}

function formatWaitResult(result: SubagentWaitResult): string {
  if (result.reports.length === 0) {
    return "No live subagent workers were present in this wait snapshot.";
  }
  return [
    "Waited worker reports:",
    ...result.reports.map((report) => report.handoff),
  ]
    .join("\n\n")
    .slice(0, MAX_WAIT_RESULT_CHARS);
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
