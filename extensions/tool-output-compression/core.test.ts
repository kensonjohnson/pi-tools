import assert from "node:assert/strict";
import test from "node:test";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
  ESTIMATED_REUSE_REFERENCE_BYTES,
  ObservationTracker,
  estimatedTokens,
  parseEligibleTools,
  percentage,
  resolveProfileMode,
  type CompressionSettings,
} from "./core.ts";
import { formatDashboard } from "./dashboard.ts";

const observeSettings: CompressionSettings = {
  enabled: true,
  mode: "observe",
  eligibleTools: ["read", "bash"],
  profileModes: {},
};

function profileMetrics() {
  return {
    candidates: 0,
    applied: 0,
    visibleBytes: 0,
    rawBytes: 0,
    projectedCompactBytes: 0,
    potentialSavedBytes: 0,
    actualSavedBytes: 0,
    recoveredFullOutput: 0,
    summary: {},
    bypasses: {},
  };
}

function result(
  toolName: string,
  text: string,
  options: { isError?: boolean; image?: boolean } = {},
): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "call-id",
    toolName,
    input: {},
    content: options.image
      ? [
          { type: "text", text },
          { type: "image", data: "not-an-image", mimeType: "image/png" },
        ]
      : [{ type: "text", text }],
    isError: options.isError ?? false,
    details: undefined,
  } as unknown as ToolResultEvent;
}

test("observes text-only output without mutating it", () => {
  const tracker = new ObservationTracker();
  const first = result("read", "x".repeat(500));
  const duplicate = result("read", "x".repeat(500));
  const before = structuredClone(first);
  tracker.observe(first, observeSettings);
  tracker.observe(duplicate, observeSettings);

  assert.deepEqual(first, before);
  const metrics = tracker.snapshot();
  assert.equal(metrics.eligibleResults, 2);
  assert.equal(metrics.exactReuses, 1);
  assert.equal(
    metrics.potentialSavedBytes,
    500 - ESTIMATED_REUSE_REFERENCE_BYTES,
  );
});

test("ignores errors, unconfigured tools, and non-text results", () => {
  const tracker = new ObservationTracker();
  tracker.observe(result("read", "failed", { isError: true }), observeSettings);
  tracker.observe(result("write", "unconfigured"), observeSettings);
  tracker.observe(result("read", "image", { image: true }), observeSettings);
  assert.equal(tracker.snapshot().eligibleResults, 0);
});

test("preserves block boundaries for exact identity", () => {
  const tracker = new ObservationTracker();
  const split = {
    ...result("read", ""),
    content: [
      { type: "text" as const, text: "ab" },
      { type: "text" as const, text: "c" },
    ],
  } as ToolResultEvent;
  const joined = {
    ...result("bash", ""),
    content: [
      { type: "text" as const, text: "a" },
      { type: "text" as const, text: "bc" },
    ],
  } as ToolResultEvent;
  tracker.observe(split, observeSettings);
  tracker.observe(joined, observeSettings);
  assert.equal(tracker.snapshot().exactReuses, 0);
});

test("resolves generic profile modes under the global safety mode", () => {
  assert.equal(resolveProfileMode(observeSettings, "go-test"), "observe");
  assert.equal(
    resolveProfileMode(
      {
        ...observeSettings,
        mode: "apply",
        profileModes: { "go-test": "apply" },
      },
      "go-test",
    ),
    "apply",
  );
  assert.equal(
    resolveProfileMode(
      { ...observeSettings, mode: "apply", profileModes: { "go-test": "off" } },
      "go-test",
    ),
    "off",
  );
  assert.equal(
    resolveProfileMode(
      { ...observeSettings, mode: "apply", profileModes: { json: "off" } },
      "json",
    ),
    "off",
  );
});

test("uses configured tools and RTK-style token estimates", () => {
  assert.deepEqual(parseEligibleTools(" read, bash,read, ,browser-content "), [
    "read",
    "bash",
    "browser-content",
  ]);
  assert.equal(estimatedTokens(5), 2);
  assert.equal(percentage(25, 100), 25);
});

test("dashboard displays generic registered profile metrics", () => {
  const text = formatDashboard({
    enabled: true,
    mode: "observe",
    eligibleTools: ["read"],
    profiles: [{ id: "go-test", label: "Go test", mode: "observe" }],
    metrics: {
      eligibleResults: 2,
      outputBytes: 4_000,
      exactReuses: 1,
      potentialSavedBytes: 1_600,
      appliedReuses: 0,
      actualSavedBytes: 0,
      byTool: {
        read: {
          eligibleResults: 2,
          outputBytes: 4_000,
          exactReuses: 1,
          potentialSavedBytes: 1_600,
          appliedReuses: 0,
          actualSavedBytes: 0,
        },
      },
      profiles: {
        "go-test": {
          ...profileMetrics(),
          candidates: 1,
          visibleBytes: 4_000,
          rawBytes: 8_000,
          projectedCompactBytes: 200,
          potentialSavedBytes: 3_800,
          summary: { testedPackages: 24, noTestPackages: 8 },
        },
      },
    },
  });
  assert.match(text, /Potential tokens saved\s+~400 tokens \(40%\)/);
  assert.match(text, /Go test \(OBSERVE\) · 1 candidates/);
  assert.match(text, /testedPackages: 24, noTestPackages: 8/);
});
