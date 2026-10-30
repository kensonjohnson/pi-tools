import type { MemoryReviewer } from "./reviewer.ts";
import { REVIEW_GAP_REASONS } from "./scheduler.ts";
import type {
  ReviewGapReason,
  IncrementalFragmentProgress,
  ManualCursor,
  SchedulerOutcome,
} from "./scheduler.ts";

/** Bounded full review; after each mutation the complete snapshot is reviewed again. */
export async function reviewAllMemories(options: {
  reviewer: MemoryReviewer;
  signal: AbortSignal;
  maxPasses?: number;
  fullOffset?: number;
  fullSnapshot?: string;
  priorEvidenceGaps?: boolean;
  onProgress?: (cursor: ManualCursor | undefined) => void;
}): Promise<SchedulerOutcome> {
  const changes: Array<{ id: string; detail: string }> = [];
  let offset = options.fullOffset,
    snapshot = options.fullSnapshot;
  let pages = 0;
  // Old cursors have no coverage state. Do not claim success for an unknown prefix.
  let snapshotHasGaps =
    options.fullOffset !== undefined && options.fullOffset > 0
      ? options.priorEvidenceGaps !== false
      : false;
  let evidenceGaps: number | undefined;
  let limitedPages = 0;
  let discoveryTruncatedPages = 0;
  let searchIncompletePages = 0;
  let candidatesTruncatedPages = 0;
  let memoryEvaluations: number | undefined;
  let snapshotMemories: number | undefined;
  const gapReasons: Partial<Record<ReviewGapReason, number>> = {};
  const progress = () => ({
    pages,
    resumedAtOffset: options.fullOffset ?? 0,
    ...(evidenceGaps === undefined
      ? {}
      : {
          evidenceGaps,
          limitedPages,
          discoveryTruncatedPages,
          searchIncompletePages,
          candidatesTruncatedPages,
          ...(memoryEvaluations === undefined ? {} : { memoryEvaluations }),
          ...(snapshotMemories === undefined ? {} : { snapshotMemories }),
          ...(Object.keys(gapReasons).length
            ? { gapReasons: { ...gapReasons } }
            : {}),
        }),
  });
  try {
    for (let pass = 0; pass < (options.maxPasses ?? 24); pass++) {
      options.signal.throwIfAborted();
      let result: Awaited<ReturnType<MemoryReviewer["review"]>>;
      try {
        result = await options.reviewer.review({
          signal: options.signal,
          fullOffset: offset,
          fullSnapshot: snapshot,
          ...(options.onProgress
            ? {
                onFragmentProgress: (progress: {
                  snapshot: string;
                  fragment: IncrementalFragmentProgress;
                }) =>
                  options.onProgress!({
                    offset: offset ?? 0,
                    ...progress,
                    evidenceGaps: snapshotHasGaps,
                  }),
              }
            : {}),
        });
      } catch (error) {
        if (
          offset !== undefined &&
          error instanceof Error &&
          error.message ===
            "review snapshot changed or is missing; restart at zero"
        ) {
          options.onProgress?.(undefined);
          options.reviewer.restartFullReview();
          offset = undefined;
          snapshot = undefined;
          snapshotHasGaps = false;
          continue;
        }
        throw error;
      }
      pages++;
      // Optional aggregate metadata is supplied by reviewers that can identify
      // evidence gaps. Never persist paths, excerpts, or model-generated text.
      const audit = result.audit;
      if (
        audit &&
        (audit.coverage === "limited" || audit.coverage === "insufficient")
      ) {
        evidenceGaps ??= 0;
        if (audit.coverage === "insufficient") {
          evidenceGaps++;
          snapshotHasGaps = true;
        } else limitedPages++;
        if (Number.isSafeInteger(audit.pageCount) && audit.pageCount! >= 0)
          memoryEvaluations = (memoryEvaluations ?? 0) + audit.pageCount!;
        if (
          Number.isSafeInteger(audit.totalMemories) &&
          audit.totalMemories! >= 0
        )
          snapshotMemories = audit.totalMemories;
        const reasons = (audit as typeof audit & { gapReasons?: unknown })
          .gapReasons;
        if (Array.isArray(reasons)) {
          for (const reason of new Set(reasons))
            if (REVIEW_GAP_REASONS.includes(reason as ReviewGapReason)) {
              const key = reason as ReviewGapReason;
              gapReasons[key] = (gapReasons[key] ?? 0) + 1;
            }
        }
        if (audit.discoveryTruncated) discoveryTruncatedPages++;
        if (audit.searchIncomplete) searchIncompletePages++;
        if (audit.candidatesTruncated) candidatesTruncatedPages++;
      }
      if (result.status === "uncertain" || result.status === "unresolved")
        return {
          status: result.status,
          detail:
            result.status === "unresolved"
              ? audit?.coverage === "insufficient"
                ? "Insufficient evidence for this memory page; inspect evidence gaps."
                : "Review found an unresolved evidence or authority conflict; inspect before resuming."
              : "Review outcome is uncertain; inspect before resuming.",
          changes,
          review: progress(),
        };
      if (result.status === "applied") {
        changes.push({
          id: result.memoryId ?? "unknown",
          detail: result.detail,
        });
        options.onProgress?.(undefined);
        offset = undefined;
        snapshot = undefined;
        snapshotHasGaps = false;
        continue;
      }
      if (result.nextOffset !== undefined) {
        if (!result.fullSnapshot)
          throw new Error("manual review continuation has no snapshot");
        options.onProgress?.({
          offset: result.nextOffset,
          snapshot: result.fullSnapshot,
          evidenceGaps: snapshotHasGaps,
        });
        offset = result.nextOffset;
        snapshot = result.fullSnapshot;
        continue;
      }
      if (/re-review remains required/i.test(result.detail))
        return {
          status: "unresolved",
          detail: result.detail,
          changes,
          review: progress(),
        };
      options.onProgress?.(undefined);
      return {
        status: snapshotHasGaps ? "unresolved" : "done",
        detail: snapshotHasGaps
          ? "Full review traversal finished with insufficient or unknown evidence; retry the full review."
          : "Full model review pass finished. Evidence gaps may remain; no-change decisions do not verify that memories are current.",
        changes,
        review: progress(),
      };
    }
    return {
      status: "pending",
      detail:
        "Full review reached its pass limit; request another review to continue.",
      changes,
      review: progress(),
      ...(offset === undefined
        ? {}
        : { nextOffset: offset, fullSnapshot: snapshot }),
    };
  } catch (error) {
    if (changes.length)
      return {
        status: "uncertain",
        detail:
          "Full review stopped after applying changes; inspect before retrying.",
        changes,
        review: progress(),
      };
    throw error;
  }
}
