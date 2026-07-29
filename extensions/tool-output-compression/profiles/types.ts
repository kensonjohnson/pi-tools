export type ProfileBypass = {
  applicable: false;
  reason: string;
};

export type ProfileCandidate = {
  applicable: true;
  rawBytes: number;
  summary: Record<string, number>;
  render(referenceId: string): string;
};

export type ProfileAnalysis = ProfileCandidate | ProfileBypass;

/** A strict result-side grammar adapter; the engine owns storage and patching. */
export type OutputProfile = {
  id: string;
  settingKey: string;
  label: string;
  toolNames: readonly string[];
  mayMatch(visibleContent: string): boolean;
  analyze(rawContent: string): ProfileAnalysis;
};
