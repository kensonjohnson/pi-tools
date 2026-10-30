import type { MemoryReviewer } from "./reviewer.ts";
import type { SchedulerOutcome } from "./scheduler.ts";

/** Bounded full review; after each mutation the complete snapshot is reviewed again. */
export async function reviewAllMemories(options: {
  reviewer: MemoryReviewer;
  signal: AbortSignal;
  maxPasses?: number;
  fullOffset?: number;
  fullSnapshot?: string;
  onProgress?: (
    cursor: { offset: number; snapshot: string } | undefined,
  ) => void;
}): Promise<SchedulerOutcome> {
  const changes: Array<{ id: string; detail: string }> = [];
  let offset = options.fullOffset,
    snapshot = options.fullSnapshot;
  let pages = 0;
  let evidenceGaps: number | undefined;
  let limitedPages = 0;
  let discoveryTruncatedPages = 0;
  let searchIncompletePages = 0;
  let candidatesTruncatedPages = 0;
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
        }),
  });
  try {
    for (let pass = 0; pass < (options.maxPasses ?? 24); pass++) {
      options.signal.throwIfAborted();
      const result = await options.reviewer.review({
        signal: options.signal,
        fullOffset: offset,
        fullSnapshot: snapshot,
      });
      pages++;
      // Optional aggregate metadata is supplied by reviewers that can identify
      // evidence gaps. Never persist paths, excerpts, or model-generated text.
      const audit = result.audit;
      if (
        audit &&
        (audit.coverage === "limited" || audit.coverage === "insufficient")
      ) {
        evidenceGaps ??= 0;
        if (audit.coverage === "insufficient") evidenceGaps++;
        else limitedPages++;
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
        continue;
      }
      if (result.nextOffset !== undefined) {
        if (!result.fullSnapshot)
          throw new Error("manual review continuation has no snapshot");
        options.onProgress?.({
          offset: result.nextOffset,
          snapshot: result.fullSnapshot,
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
        status: "done",
        detail:
          "Full model review pass finished. Evidence gaps may remain; no-change decisions do not verify that memories are current.",
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
