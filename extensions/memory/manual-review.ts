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
  try {
    for (let pass = 0; pass < (options.maxPasses ?? 24); pass++) {
      options.signal.throwIfAborted();
      const result = await options.reviewer.review({
        signal: options.signal,
        fullOffset: offset,
        fullSnapshot: snapshot,
      });
      if (result.status === "uncertain" || result.status === "unresolved")
        return { status: result.status, detail: result.detail, changes };
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
        return { status: "unresolved", detail: result.detail, changes };
      options.onProgress?.(undefined);
      return {
        status: "done",
        detail: "Full memory review completed.",
        changes,
      };
    }
    return {
      status: "pending",
      detail:
        "Full review reached its pass limit; request another review to continue.",
      changes,
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
      };
    throw error;
  }
}
