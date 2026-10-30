// Only allowlisted labels and numeric/boolean metadata leave this module.
const actions = ["add", "update", "remove", "move", "no_change", "unresolved"];
const requestKinds = ["paths", "excerpts", "missing", "search"];
const flags = [
  "evidenceFragmented",
  "sessionFragmented",
  "metadataFragmented",
  "memoryFragmented",
];
const numbers = [
  "evidencePage",
  "evidencePages",
  "sessionPage",
  "sessionPages",
  "metadataPage",
  "metadataPages",
  "memoryPage",
  "memoryPages",
];
const stages = [
  "evidence_selection",
  "assessment",
  "comparison",
  "decision",
  "other",
];
const safeCount = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 1000000;
const detailCodes = new Map([
  [
    "Multiple proposals require a complete joint assessment; nothing was changed.",
    "multiple_proposals_need_joint_assessment",
  ],
  [
    "Comparison proposal requires a complete joint assessment; nothing was changed.",
    "comparison_needs_joint_assessment",
  ],
  [
    "Incomplete read-only fragments or conflicting proposals lack complete target and source context; nothing was changed.",
    "fragment_context_or_conflict",
  ],
  [
    "Insufficient evidence on this page; no supported changes proposed.",
    "insufficient_evidence_no_supported_changes",
  ],
  [
    "No supported changes proposed; evidence coverage is limited.",
    "no_supported_changes_limited",
  ],
  [
    "Insufficient evidence on this page; remaining pages still require review.",
    "insufficient_evidence_more_pages",
  ],
  [
    "Insufficient evidence for this memory page; inspect evidence gaps.",
    "insufficient_evidence_page",
  ],
  [
    "Review found an unresolved evidence or authority conflict; inspect before resuming.",
    "unresolved_conflict",
  ],
  [
    "Review outcome is uncertain; inspect before resuming.",
    "uncertain_outcome",
  ],
  [
    "Full review traversal finished with insufficient or unknown evidence; retry the full review.",
    "traversal_insufficient",
  ],
  [
    "Full model review pass finished. Evidence gaps may remain; no-change decisions do not verify that memories are current.",
    "traversal_finished",
  ],
  [
    "Full review reached its pass limit; request another review to continue.",
    "pass_limit",
  ],
  [
    "Full review stopped after applying changes; inspect before retrying.",
    "uncertain_after_changes",
  ],
]);
const statusValues = [
  "applied",
  "unchanged",
  "unresolved",
  "uncertain",
  "done",
  "pending",
  "error",
  "unsupported-session",
];
export function summarizeOutcome(result) {
  return {
    status: statusValues.includes(result?.status) ? result.status : "other",
    detailCode: detailCodes.get(result?.detail) ?? "other",
  };
}

export function summarize(request, value, failed = false) {
  const instruction =
    typeof request?.instruction === "string" ? request.instruction : "";
  const stage = instruction.startsWith("Select")
    ? "evidence_selection"
    : instruction.startsWith("Independently")
      ? "assessment"
      : instruction.startsWith("Compare")
        ? "comparison"
        : instruction.includes('Return JSON {"proposals"')
          ? "decision"
          : "other";
  const entry = { stage, outcome: failed ? "error" : "response" };
  const data = request?.data;
  if (data && typeof data === "object") {
    const page = {};
    for (const key of flags)
      if (typeof data[key] === "boolean") page[key] = data[key];
    for (const key of numbers) if (safeCount(data[key])) page[key] = data[key];
    if (Object.keys(page).length) entry.page = page;
  }
  if (failed || !value || typeof value !== "object" || Array.isArray(value))
    return entry;
  if (stage === "evidence_selection") {
    entry.evidenceRequests = {};
    for (const key of requestKinds)
      if (Array.isArray(value[key]))
        entry.evidenceRequests[key] = Math.min(value[key].length, 1000000);
  }
  if (stage === "decision" || stage === "comparison") {
    const proposals = Array.isArray(value.proposals)
      ? value.proposals
      : [value];
    entry.proposalCount = Math.min(proposals.length, 1000000);
    entry.actionCounts = Object.fromEntries(actions.map((x) => [x, 0]));
    entry.actionCounts.other = 0;
    entry.evidenceSufficient = { true: 0, false: 0, missing: 0 };
    entry.proposals = [];
    entry.proposalsOmitted = Math.max(
      0,
      Math.min(proposals.length, 1000000) - 50,
    );
    // Bound CPU even if a fake or compromised adapter supplies an enormous response.
    for (const item of proposals.slice(0, 10000)) {
      const action =
        item && typeof item === "object" && actions.includes(item.action)
          ? item.action
          : "other";
      entry.actionCounts[action]++;
      const sufficient =
        item && typeof item === "object" ? item.evidenceSufficient : undefined;
      entry.evidenceSufficient[
        typeof sufficient === "boolean" ? String(sufficient) : "missing"
      ]++;
      if (entry.proposals.length < 50) {
        const citation =
          item &&
          typeof item === "object" &&
          item.citation &&
          typeof item.citation === "object"
            ? item.citation
            : {};
        entry.proposals.push({
          action,
          citationKind: ["file", "session", "memory"].includes(citation.kind)
            ? citation.kind
            : "other",
          targetAuthority: ["fact", "instruction", "unknown"].includes(
            item?.targetAuthority,
          )
            ? item.targetAuthority
            : "other",
          citationQuoteNonempty:
            typeof citation.quote === "string" &&
            citation.quote.trim().length > 0,
          targetIdPresent:
            typeof item?.id === "string" && item.id.trim().length > 0,
        });
      }
    }
    if (proposals.length > 10000) entry.proposalsTruncated = true;
  }
  if (
    stage === "assessment" &&
    ["supported", "unsupported", "uncertain"].includes(value.verdict)
  )
    entry.verdict = value.verdict;
  return entry;
}

// Revalidate the adapter's report at the boundary; never forward arbitrary text.
export function sanitizeDiagnostics(value) {
  if (!value || !Array.isArray(value.entries) || !safeCount(value.omitted))
    return undefined;
  const entries = [];
  for (const item of value.entries.slice(0, 200)) {
    if (
      !item ||
      !stages.includes(item.stage) ||
      !["error", "response"].includes(item.outcome)
    )
      continue;
    const out = { stage: item.stage, outcome: item.outcome };
    if (item.page && typeof item.page === "object") {
      const page = {};
      for (const key of flags)
        if (typeof item.page[key] === "boolean") page[key] = item.page[key];
      for (const key of numbers)
        if (safeCount(item.page[key])) page[key] = item.page[key];
      if (Object.keys(page).length) out.page = page;
    }
    if (safeCount(item.proposalCount)) out.proposalCount = item.proposalCount;
    for (const [key, keys] of [
      ["actionCounts", [...actions, "other"]],
      ["evidenceRequests", requestKinds],
      ["evidenceSufficient", ["true", "false", "missing"]],
    ]) {
      if (!item[key] || typeof item[key] !== "object") continue;
      out[key] = {};
      for (const name of keys)
        if (safeCount(item[key][name])) out[key][name] = item[key][name];
    }
    if (Array.isArray(item.proposals)) {
      out.proposals = item.proposals
        .slice(0, 50)
        .filter((x) => x && typeof x === "object")
        .map((x) => ({
          action: [...actions, "other"].includes(x.action) ? x.action : "other",
          citationKind: ["file", "session", "memory"].includes(x.citationKind)
            ? x.citationKind
            : "other",
          targetAuthority: ["fact", "instruction", "unknown"].includes(
            x.targetAuthority,
          )
            ? x.targetAuthority
            : "other",
          citationQuoteNonempty: x.citationQuoteNonempty === true,
          targetIdPresent: x.targetIdPresent === true,
        }));
      if (safeCount(item.proposalsOmitted))
        out.proposalsOmitted = Math.min(
          1000000,
          item.proposalsOmitted + Math.max(0, item.proposals.length - 50),
        );
    }
    if (item.proposalsTruncated === true) out.proposalsTruncated = true;
    if (["supported", "unsupported", "uncertain"].includes(item.verdict))
      out.verdict = item.verdict;
    entries.push(out);
  }
  const result = {
    entries,
    omitted: Math.min(
      1000000,
      value.omitted + Math.max(0, value.entries.length - 200),
    ),
  };
  if (Array.isArray(value.reviewOutcomes)) {
    const validCodes = new Set([...detailCodes.values(), "other"]);
    result.reviewOutcomes = value.reviewOutcomes
      .slice(0, 200)
      .filter((x) => x && typeof x === "object")
      .map((x) => ({
        status: statusValues.includes(x.status) ? x.status : "other",
        detailCode: validCodes.has(x.detailCode) ? x.detailCode : "other",
      }));
    result.reviewOutcomesOmitted = Math.min(
      1000000,
      (safeCount(value.reviewOutcomesOmitted)
        ? value.reviewOutcomesOmitted
        : 0) + Math.max(0, value.reviewOutcomes.length - 200),
    );
  }
  if (value.finalOutcome && typeof value.finalOutcome === "object") {
    const validCodes = new Set([...detailCodes.values(), "other"]);
    result.finalOutcome = {
      status: statusValues.includes(value.finalOutcome.status)
        ? value.finalOutcome.status
        : "other",
      detailCode: validCodes.has(value.finalOutcome.detailCode)
        ? value.finalOutcome.detailCode
        : "other",
    };
  }
  return result;
}
