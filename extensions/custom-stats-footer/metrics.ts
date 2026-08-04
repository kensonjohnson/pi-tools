import type { AssistantMessage } from "@earendil-works/pi-ai";

type FinalResponse = Pick<AssistantMessage, "stopReason" | "usage">;

export type ResponseTpsSnapshot = {
  lastTps: number | null;
  averageTps: number | null;
};

export class ResponseTpsMeter {
  #startedAtMs: number | undefined;
  #lastTps: number | null = null;
  #totalOutputTokens = 0;
  #totalDurationMs = 0;
  #now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  reset(): void {
    this.#startedAtMs = undefined;
    this.#lastTps = null;
    this.#totalOutputTokens = 0;
    this.#totalDurationMs = 0;
  }

  start(): void {
    this.#startedAtMs = this.#now();
  }

  finish(message: FinalResponse): boolean {
    const startedAtMs = this.#startedAtMs;
    this.#startedAtMs = undefined;
    if (startedAtMs === undefined) return false;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return false;
    }

    const outputTokens = message.usage.output;
    const durationMs = this.#now() - startedAtMs;
    if (
      !Number.isFinite(outputTokens) ||
      outputTokens <= 0 ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0
    ) {
      return false;
    }

    this.#lastTps = outputTokens / (durationMs / 1000);
    this.#totalOutputTokens += outputTokens;
    this.#totalDurationMs += durationMs;
    return true;
  }

  snapshot(): ResponseTpsSnapshot {
    return {
      lastTps: this.#lastTps,
      averageTps:
        this.#totalDurationMs > 0
          ? this.#totalOutputTokens / (this.#totalDurationMs / 1000)
          : null,
    };
  }
}
