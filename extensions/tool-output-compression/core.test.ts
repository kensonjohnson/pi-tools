import assert from "node:assert/strict";
import test from "node:test";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
  ESTIMATED_REUSE_REFERENCE_BYTES,
  ObservationTracker,
  estimatedTokens,
  parseEligibleTools,
  percentage,
  type CompressionSettings,
} from "./core.ts";
import { formatDashboard } from "./dashboard.ts";

const observeSettings: CompressionSettings = {
  enabled: true,
  mode: "observe",
  eligibleTools: ["read", "bash"],
};

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
          {
            type: "image",
            data: "not-a-real-image",
            mimeType: "image/png",
          },
        ]
      : [{ type: "text", text }],
    isError: options.isError ?? false,
    details: undefined,
  } as unknown as ToolResultEvent;
}

test("observe mode leaves results untouched and records only safe aggregates", () => {
  const tracker = new ObservationTracker();
  const first = result("read", "x".repeat(500));
  const duplicate = result("read", "x".repeat(500));
  const firstBefore = structuredClone(first);
  const duplicateBefore = structuredClone(duplicate);

  tracker.observe(first, observeSettings);
  tracker.observe(duplicate, observeSettings);

  assert.deepEqual(first, firstBefore);
  assert.deepEqual(duplicate, duplicateBefore);

  const metrics = tracker.snapshot();
  assert.equal(metrics.eligibleResults, 2);
  assert.equal(metrics.outputBytes, 1_000);
  assert.equal(metrics.exactReuses, 1);
  assert.equal(
    metrics.potentialSavedBytes,
    500 - ESTIMATED_REUSE_REFERENCE_BYTES,
  );
  assert.deepEqual(Object.keys(metrics.byTool), ["read"]);
});

test("ignores errors, unconfigured tools, non-text results, disabled mode, and short repeats", () => {
  const tracker = new ObservationTracker();
  const short = result("read", "short");

  tracker.observe(result("read", "failed", { isError: true }), observeSettings);
  tracker.observe(result("write", "unconfigured"), observeSettings);
  tracker.observe(result("read", "image", { image: true }), observeSettings);
  tracker.observe(result("read", "disabled"), {
    ...observeSettings,
    enabled: false,
  });
  tracker.observe(short, observeSettings);
  tracker.observe(short, observeSettings);

  const metrics = tracker.snapshot();
  assert.equal(metrics.eligibleResults, 2);
  assert.equal(metrics.outputBytes, 10);
  assert.equal(metrics.exactReuses, 0);
  assert.equal(metrics.potentialSavedBytes, 0);
});

test("uses block boundaries for exact identity and supports equivalent configured tools", () => {
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
  const repeatedRead = result("read", "x".repeat(500));
  const sameFromBash = result("bash", "x".repeat(500));

  tracker.observe(split, observeSettings);
  tracker.observe(joined, observeSettings);
  tracker.observe(repeatedRead, observeSettings);
  tracker.observe(sameFromBash, observeSettings);

  const metrics = tracker.snapshot();
  assert.equal(metrics.exactReuses, 1);
  assert.equal(metrics.byTool.read.exactReuses, 0);
  assert.equal(metrics.byTool.bash.exactReuses, 1);
});

test("parses configured tools and uses RTK-style token estimates", () => {
  assert.deepEqual(parseEligibleTools(" read, bash,read, ,browser-content "), [
    "read",
    "bash",
    "browser-content",
  ]);
  assert.equal(estimatedTokens(0), 0);
  assert.equal(estimatedTokens(1), 1);
  assert.equal(estimatedTokens(4), 1);
  assert.equal(estimatedTokens(5), 2);
  assert.equal(percentage(25, 100), 25);
});

test("dashboard prioritizes estimated token savings for configured tools", () => {
  const text = formatDashboard({
    enabled: true,
    mode: "observe",
    eligibleTools: ["read", "bash"],
    metrics: {
      eligibleResults: 3,
      outputBytes: 4_000,
      exactReuses: 1,
      potentialSavedBytes: 1_600,
      byTool: {
        read: {
          eligibleResults: 2,
          outputBytes: 3_000,
          exactReuses: 1,
          potentialSavedBytes: 1_600,
        },
        bash: {
          eligibleResults: 1,
          outputBytes: 1_000,
          exactReuses: 0,
          potentialSavedBytes: 0,
        },
      },
    },
  });

  assert.match(text, /Potential tokens saved\s+~400 tokens \(40%\)/);
  assert.match(text, /read\s+~750 tokens\s+~400 tokens\s+53%\s+1/);
  assert.match(text, /bash\s+~250 tokens\s+~0 tokens\s+0\.0%\s+0/);
  assert.doesNotMatch(text, /candidates/i);
});
