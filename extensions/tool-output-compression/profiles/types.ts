import type { RawOutputProbe } from "../raw-capture.ts";

export type ProfileBypass = {
  applicable: false;
  reason: string;
};

export type ProfileRenderOptions = {
  visibleBytes: number;
  rawSource: "visible" | "full-output-path";
};

/** Optional tool-call evidence shared by result-side profiles. */
export type ProfileContext = {
  bashCommand?: string;
};

export type ProfileCandidate = {
  applicable: true;
  rawBytes: number;
  summary: Record<string, number>;
  render(referenceId: string, options?: ProfileRenderOptions): string;
};

export type ProfileAnalysis = ProfileCandidate | ProfileBypass;

/** A strict result-side grammar adapter; the engine owns storage and patching. */
export type OutputProfile = {
  id: string;
  settingPath: string;
  label: string;
  toolNames: readonly string[];
  mayMatch(visibleContent: string, context?: ProfileContext): boolean;
  /** Optional bounded full-output probe for profiles that recover Pi tails. */
  mayMatchRecoveredRaw?(
    probe: RawOutputProbe,
    context?: ProfileContext,
  ): boolean;
  analyze(rawContent: string, context?: ProfileContext): ProfileAnalysis;
};
