import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarize,
  sanitizeDiagnostics,
  summarizeOutcome,
} from "./diagnostics.mjs";

test("summaries expose only fixed labels, counts and fragment metadata", () => {
  const selection = summarize(
    {
      instruction: "Select evidence",
      data: { repositoryPaths: ["SECRET_PATH"] },
    },
    {
      paths: ["SECRET_PATH"],
      excerpts: [{ path: "SECRET_PATH", query: "SECRET" }],
      search: ["SECRET"],
    },
  );
  assert.deepEqual(selection.evidenceRequests, {
    paths: 1,
    excerpts: 1,
    search: 1,
  });
  const decision = summarize(
    {
      instruction: 'Evidence failures. Return JSON {"proposals"',
      data: {
        memoryFragmented: true,
        memoryPage: 2,
        memoryPages: 3,
        secret: "SECRET",
      },
    },
    {
      proposals: [
        {
          action: "update",
          id: "SECRET_ID",
          targetAuthority: "fact",
          citation: { kind: "file", id: "SECRET_PATH", quote: "SECRET_QUOTE" },
          reason: "SECRET",
          content: "SECRET",
        },
        { action: "no_change", evidenceSufficient: false, reason: "SECRET" },
      ],
    },
  );
  assert.equal(decision.proposalCount, 2);
  assert.equal(decision.actionCounts.update, 1);
  assert.equal(decision.evidenceSufficient.false, 1);
  assert.equal(decision.page.memoryFragmented, true);
  assert.deepEqual(decision.proposals[0], {
    action: "update",
    citationKind: "file",
    targetAuthority: "fact",
    citationQuoteNonempty: true,
    targetIdPresent: true,
  });
  assert.deepEqual(decision.proposals[1], {
    action: "no_change",
    citationKind: "other",
    targetAuthority: "other",
    citationQuoteNonempty: false,
    targetIdPresent: false,
  });
  assert.ok(!JSON.stringify([selection, decision]).includes("SECRET"));
  const malicious = sanitizeDiagnostics({
    entries: [
      {
        ...decision,
        stage: "decision",
        unknown: "SECRET",
        actionCounts: { update: 1, SECRET: 99 },
        page: { memoryFragmented: true, secret: "SECRET" },
      },
    ],
    omitted: 0,
  });
  assert.ok(!JSON.stringify(malicious).includes("SECRET"));
  assert.equal(malicious.entries[0].actionCounts.update, 1);
  assert.equal(malicious.entries[0].proposals[0].citationKind, "file");
  assert.equal(
    summarizeOutcome({
      status: "unresolved",
      detail:
        "Multiple proposals require a complete joint assessment; nothing was changed.",
    }).detailCode,
    "multiple_proposals_need_joint_assessment",
  );
  assert.equal(
    summarizeOutcome({ status: "unresolved", detail: "SECRET model rationale" })
      .detailCode,
    "other",
  );
  const outcome = sanitizeDiagnostics({
    entries: [],
    omitted: 0,
    reviewOutcomes: [{ status: "unresolved", detailCode: "SECRET" }],
    finalOutcome: { status: "done", detailCode: "SECRET" },
  });
  assert.ok(!JSON.stringify(outcome).includes("SECRET"));
  assert.equal(
    summarize(
      {
        instruction:
          "Independently compare this evidence fragment against the target",
      },
      { verdict: "no_conflict" },
    ).stage,
    "evidence_crosscheck",
  );
  assert.equal(
    summarize(
      { instruction: "Independently assess whether removing target" },
      {},
    ).stage,
    "semantic_assessment",
  );
  const totals = sanitizeDiagnostics({
    entries: [],
    omitted: 0,
    stageTotals: {
      evidence_crosscheck: {
        attempts: 4,
        errors: 1,
        elapsedMs: 123,
        secret: "SECRET",
      },
      assessment: { attempts: 1, errors: 2, elapsedMs: 1 },
      SECRET: { attempts: 1, errors: 0, elapsedMs: 1 },
    },
  });
  assert.deepEqual(totals.stageTotals, {
    evidence_crosscheck: { attempts: 4, errors: 1, elapsedMs: 123 },
  });
  assert.ok(!JSON.stringify(totals).includes("SECRET"));
});
