import assert from "node:assert/strict";
import test from "node:test";
import { getCodexQuotaColor, type CodexQuotaColor } from "./quota-color.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW_MS = 1_000_000;

test("uses the pace target and its color boundaries for valid resets", () => {
  const cases: Array<{
    name: string;
    remainingPercent: number;
    resetAtMs: number;
    expected: CodexQuotaColor;
  }> = [
    {
      name: "at 1 day 9 hours, 50% is green",
      remainingPercent: 50,
      resetAtMs: NOW_MS + 33 * HOUR_MS,
      expected: "success",
    },
    {
      name: "at 1 day 9 hours, 10% is yellow",
      remainingPercent: 10,
      resetAtMs: NOW_MS + 33 * HOUR_MS,
      expected: "warning",
    },
    {
      name: "at the target is green",
      remainingPercent: 14,
      resetAtMs: NOW_MS + DAY_MS,
      expected: "success",
    },
    {
      name: "below the target and at half is yellow",
      remainingPercent: 7,
      resetAtMs: NOW_MS + DAY_MS,
      expected: "warning",
    },
    {
      name: "below half the target is red",
      remainingPercent: 6.99,
      resetAtMs: NOW_MS + DAY_MS,
      expected: "error",
    },
  ];

  for (const { name, remainingPercent, resetAtMs, expected } of cases) {
    assert.equal(
      getCodexQuotaColor(remainingPercent, resetAtMs, NOW_MS),
      expected,
      name,
    );
  }
});

test("clamps the pace target to 100%", () => {
  const resetAtMs = NOW_MS + 20 * DAY_MS;

  assert.equal(getCodexQuotaColor(100, resetAtMs, NOW_MS), "success");
  assert.equal(getCodexQuotaColor(99, resetAtMs, NOW_MS), "warning");
  assert.equal(getCodexQuotaColor(49.99, resetAtMs, NOW_MS), "error");
});

test("uses fixed bands when the reset timestamp is unavailable or expired", () => {
  const cases: Array<{
    name: string;
    resetAtMs: number | undefined;
    remainingPercent: number;
    expected: CodexQuotaColor;
  }> = [
    {
      name: "unknown reset below 20%",
      resetAtMs: undefined,
      remainingPercent: 19.99,
      expected: "error",
    },
    {
      name: "invalid reset at 20%",
      resetAtMs: Number.NaN,
      remainingPercent: 20,
      expected: "warning",
    },
    {
      name: "non-finite reset below 50%",
      resetAtMs: Number.POSITIVE_INFINITY,
      remainingPercent: 49.99,
      expected: "warning",
    },
    {
      name: "expired reset at 50%",
      resetAtMs: NOW_MS,
      remainingPercent: 50,
      expected: "warning",
    },
  ];

  for (const { name, resetAtMs, remainingPercent, expected } of cases) {
    assert.equal(
      getCodexQuotaColor(remainingPercent, resetAtMs, NOW_MS),
      expected,
      name,
    );
  }
});
