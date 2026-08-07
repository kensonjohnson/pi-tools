export type CodexQuotaColor = "error" | "warning" | "success";

function fixedBandColor(remainingPercent: number): CodexQuotaColor {
  if (remainingPercent < 20) return "error";
  if (remainingPercent <= 50) return "warning";
  return "success";
}

export function getCodexQuotaColor(
  remainingPercent: number,
  resetAtMs: number | undefined,
  nowMs: number,
): CodexQuotaColor {
  if (
    !Number.isFinite(resetAtMs) ||
    !Number.isFinite(nowMs) ||
    resetAtMs === undefined ||
    resetAtMs <= nowMs
  ) {
    return fixedBandColor(remainingPercent);
  }

  const daysUntilReset = (resetAtMs - nowMs) / (24 * 60 * 60 * 1000);
  const target = Math.max(0, Math.min(100, 14 * daysUntilReset));
  if (remainingPercent >= target) return "success";
  if (remainingPercent >= target / 2) return "warning";
  return "error";
}
