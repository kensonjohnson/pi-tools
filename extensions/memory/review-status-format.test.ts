import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReviewStatus } from "./index.ts";
import type { SchedulerReport } from "./scheduler.ts";

const status = (): SchedulerReport["status"] => ({
  pending: 0,
  unsupportedSessions: 0,
  paused: false,
  inflight: false,
  status: "idle",
  cooldownUntil: 0,
  unpersistedActivities: 0,
  activityFlushPending: false,
});

test("formats empty and pending states without triggering work", () => {
  const text = formatReviewStatus({
    status: status(),
    configuredModel: null,
    historyEnabled: false,
    events: [],
  });
  assert.match(text, /State: idle/);
  assert.match(text, /Pending: 0/);
  assert.match(text, /Reviewer model: not configured/);
  assert.match(text, /None\./);
  assert.doesNotMatch(text, /[{}]/);
  const paused = formatReviewStatus({
    status: {
      ...status(),
      paused: true,
      inflight: true,
      pending: 3,
      unsupportedSessions: 1,
      status: "interrupted-uncertain",
      manualContinuation: { offset: 10, snapshot: "secret" },
      activityFlushPending: true,
    },
    configuredModel: "provider/model",
    historyEnabled: true,
    events: [],
  });
  assert.match(paused, /paused \(work in flight\)/);
  assert.match(paused, /Pending: 3; unsupported sessions: 1/);
  assert.match(paused, /offset 10/);
  assert.match(paused, /flush pending/);
  assert.doesNotMatch(paused, /secret/);
});

test("explains unresolved insufficient evidence and its page summary without requiring resume", () => {
  const event: SchedulerReport["events"][number] = {
    at: Date.UTC(2025, 0, 1),
    mode: "manual",
    status: "unresolved",
    detail:
      "Insufficient evidence for this memory page; inspect evidence gaps.",
    changes: [],
    changesTotal: 0,
    changesOmitted: 0,
    review: {
      pages: 3,
      resumedAtOffset: 4,
      evidenceGaps: 1,
      limitedPages: 1,
      discoveryTruncatedPages: 1,
      searchIncompletePages: 0,
      candidatesTruncatedPages: 0,
    },
  };
  const text = formatReviewStatus({
    status: { ...status(), status: "unresolved" },
    configuredModel: "p/model",
    historyEnabled: true,
    events: [event],
  });
  assert.match(text, /State: idle/);
  assert.match(text, /Insufficient evidence for this memory page/);
  assert.match(text, /Pages: 3; changes: 0/);
  assert.match(text, /Started at offset: 4/);
  assert.match(text, /Evidence: 1 insufficient, 1 limited/);
  assert.match(
    text,
    /Discovery truncated: 1; search incomplete: 0; candidates truncated: 0/,
  );
  assert.match(text, /Coverage is not verification/);
  assert.match(text, /Run \/memory-review full again to retry/);
  assert.doesNotMatch(text, /\/memory-review resume/);
});

test("preserves inspection guidance for paused uncertain and cancelled reviews", () => {
  for (const state of ["uncertain", "cancelled"]) {
    const text = formatReviewStatus({
      status: { ...status(), paused: true, status: state },
      configuredModel: null,
      historyEnabled: false,
      events: [],
    });
    assert.match(
      text,
      /Inspect the latest outcome before using \/memory-review resume/,
    );
  }
});

test("legacy unresolved detail does not require resume", () => {
  const text = formatReviewStatus({
    status: { ...status(), status: "unresolved" },
    configuredModel: null,
    historyEnabled: false,
    events: [
      {
        at: 0,
        mode: "manual",
        status: "unresolved",
        detail:
          "Review found an unresolved evidence or authority conflict; inspect before resuming.",
        changes: [],
        changesTotal: 0,
        changesOmitted: 0,
      },
    ],
  });
  assert.match(text, /evidence or authority conflict/);
  assert.doesNotMatch(text, /resum/);
});

test("explains incremental evidence gaps, running state, and hides model reasons", () => {
  const base: SchedulerReport["events"][number] = {
    at: 0,
    mode: "background",
    status: "unresolved",
    detail:
      "Incremental review has insufficient evidence; batch remains unacknowledged for retry.",
    changes: [],
    changesTotal: 0,
    changesOmitted: 0,
  };
  const text = formatReviewStatus({
    status: { ...status(), inflight: true, status: "running" },
    configuredModel: null,
    historyEnabled: true,
    events: [
      base,
      { ...base, detail: "secret model reason" },
      { ...base, mode: "manual", review: { pages: 1, resumedAtOffset: 0 } },
    ],
  });
  assert.match(text, /State: running/);
  assert.match(text, /Check status again after it settles/);
  assert.match(text, /Incremental review has insufficient evidence/);
  assert.match(text, /Details are unavailable or hidden/);
  assert.match(text, /Evidence coverage: unknown/);
  assert.doesNotMatch(text, /secret model reason/);
});

test("sanitizes terminal controls in recorded descriptions", () => {
  const event: SchedulerReport["events"][number] = {
    at: 0,
    mode: "manual",
    status: "done",
    detail: "",
    changes: [
      {
        id: "1",
        detail:
          "Updated [knowledge]: \u001b[31mNode\u001b[0m\nnext\rline\u001b]0;unsafe title\u0007 end\u202e",
      },
    ],
    changesTotal: 3,
    changesOmitted: 2,
  };
  const text = formatReviewStatus({
    status: status(),
    configuredModel: null,
    historyEnabled: false,
    events: [event],
  });
  assert.match(text, /Updated \[knowledge\]: Node next line end/);
  assert.doesNotMatch(text, /[\u001b\u0007\r\u202e]|unsafe title/);
  assert.match(text, /2 change\(s\) omitted/);
});

test("bounds and labels history while hiding arbitrary details", () => {
  const at = Date.UTC(2025, 1, 3, 4, 5);
  const event: SchedulerReport["events"][number] = {
    at,
    mode: "manual",
    status: "error",
    detail: "api-key=secret",
    changes: [
      { id: "secret", detail: "Added [knowledge]: The build uses Node." },
      { id: "2", detail: "Moved [knowledge -> decisions]: Keep local tests." },
    ],
    changesTotal: 20,
    changesOmitted: 18,
  };
  const text = formatReviewStatus(
    {
      status: { ...status(), cooldownUntil: at },
      configuredModel: "provider/model?token=secret",
      historyEnabled: true,
      events: [event],
    },
    12,
  );
  assert.match(
    text,
    new RegExp(
      new Date(at).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
  );
  assert.match(text, /Added \[knowledge\]: The build uses Node\./);
  assert.match(text, /Moved \[knowledge -> decisions\]: Keep local tests\./);
  assert.match(text, /18 change\(s\) omitted/);
  assert.match(text, /12 recent run\(s\) omitted/);
  assert.doesNotMatch(text, /secret|password|api-key/);
  assert.match(text, /name hidden/);
});
