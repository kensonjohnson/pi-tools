import type { ElementHandle, Page } from "playwright";
import type { ArtifactStore } from "./artifacts.ts";

export type ScreenshotLimits = {
  maxDimension: number;
  maxPixels: number;
  maxBytes: number;
  timeoutMs: number;
};
export const defaultScreenshotLimits: ScreenshotLimits = {
  maxDimension: 8192,
  maxPixels: 16_000_000,
  maxBytes: 12_000_000,
  timeoutMs: 10000,
};
export const mobileViewports = Object.freeze({
  phone: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
});
export type ViewportChoice =
  { width: number; height: number } | { preset: keyof typeof mobileViewports };

function check(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Screenshot operation cancelled.");
}
/** Must synchronously invalidate the owning session before its serialized lock is released.
 * Start owned-browser cleanup without waiting for it; cleanup can remain unverified.
 */
export type QuarantineScreenshotOwner = () => void;

async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  quarantine: QuarantineScreenshotOwner,
): Promise<T> {
  check(signal);
  if (typeof quarantine !== "function")
    throw new Error(
      "Screenshot operation requires an owner quarantine callback.",
    );
  const internal = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const pending = Promise.resolve().then(() => operation(internal.signal));
  const interrupted = new Promise<never>((_, reject) => {
    let stopped = false;
    const stop = (reason: string) => {
      if (stopped) return;
      stopped = true;
      internal.abort();
      let cleanup =
        "Owner quarantine requested; browser cleanup is not verified.";
      try {
        quarantine();
      } catch {
        cleanup = "Owner quarantine failed; browser cleanup is unverified.";
      }
      reject(
        new Error(
          `${reason} Native work may still be in flight and an artifact may have been published. ${cleanup}`,
        ),
      );
    };
    onAbort = () => stop("Screenshot operation cancelled.");
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => stop("Screenshot operation timed out."),
      timeoutMs,
    );
    if (signal?.aborted) onAbort();
  });
  try {
    return await Promise.race([pending, interrupted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function limitsValid(limits: ScreenshotLimits) {
  if (
    !Object.values(limits).every((v) => Number.isSafeInteger(v) && v > 0) ||
    limits.maxDimension > 32768 ||
    limits.maxPixels > 100_000_000 ||
    limits.maxBytes > 100_000_000 ||
    limits.timeoutMs > 30000
  )
    throw new Error("Invalid screenshot limits.");
}
function geometry(width: number, height: number, limits: ScreenshotLimits) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("Screenshot geometry is unavailable or empty.");
  width = Math.ceil(width);
  height = Math.ceil(height);
  if (
    width > limits.maxDimension ||
    height > limits.maxDimension ||
    width * height > limits.maxPixels
  )
    throw new Error(
      "Screenshot capture limit exceeded; reduce the viewport, page, or element size.",
    );
  return { width, height };
}

/** Viewport sizing only. This does not emulate touch, user agent, or a real device. */
export async function setScreenshotViewport(
  page: Page,
  choice: ViewportChoice,
  limits: ScreenshotLimits = defaultScreenshotLimits,
  signal?: AbortSignal,
  quarantine?: QuarantineScreenshotOwner,
) {
  limitsValid(limits);
  check(signal);
  const size = "preset" in choice ? mobileViewports[choice.preset] : choice;
  if (
    !size ||
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height)
  )
    throw new Error("Invalid viewport dimensions or preset.");
  geometry(size.width, size.height, limits);
  return bounded(
    async (operationSignal) => {
      check(operationSignal);
      await page.setViewportSize({ width: size.width, height: size.height });
      check(operationSignal);
      return {
        width: size.width,
        height: size.height,
        note: "Viewport dimensions only; touch, user agent and real-device behavior are not emulated.",
      };
    },
    signal,
    limits.timeoutMs,
    quarantine!,
  );
}

/** Call only inside the owning session's serialized page operation. Resolve references there. */
export async function captureScreenshot(options: {
  page: Page;
  owner: string;
  artifacts: ArtifactStore;
  scope: "viewport" | "fullPage" | "element";
  resolveElement?: () => Promise<ElementHandle>;
  transparent?: boolean;
  limits?: ScreenshotLimits;
  signal?: AbortSignal;
  quarantine: QuarantineScreenshotOwner;
}) {
  const limits = options.limits ?? defaultScreenshotLimits;
  limitsValid(limits);
  check(options.signal);
  return bounded(
    (signal) => capture({ ...options, signal }, limits),
    options.signal,
    limits.timeoutMs,
    options.quarantine,
  );
}

async function capture(
  options: Parameters<typeof captureScreenshot>[0],
  limits: ScreenshotLimits,
) {
  const { page, owner, artifacts, scope, signal } = options;
  check(signal);
  if (!["viewport", "fullPage", "element"].includes(scope))
    throw new Error("Invalid screenshot scope.");
  let handle: ElementHandle | undefined;
  let size: { width: number; height: number };
  if (scope === "element") {
    if (!options.resolveElement)
      throw new Error(
        "Element screenshot requires a snapshot reference resolver.",
      );
    handle = await options.resolveElement();
    check(signal);
    const box = await handle.boundingBox();
    if (!box)
      throw new Error(
        "Element is detached, hidden, or has no bounding box; take a new snapshot.",
      );
    size = geometry(box.width, box.height, limits);
  } else {
    const cdp = await page.context().newCDPSession(page);
    try {
      check(signal);
      const metrics = await cdp.send("Page.getLayoutMetrics");
      const rect =
        scope === "fullPage"
          ? metrics.cssContentSize
          : metrics.cssLayoutViewport;
      size = geometry(
        scope === "fullPage" ? rect.width : rect.clientWidth,
        scope === "fullPage" ? rect.height : rect.clientHeight,
        limits,
      );
    } finally {
      await cdp.detach().catch(() => {});
    }
  }
  check(signal);
  // CSS scale avoids device-pixel-ratio upscaling. Playwright may scroll an element into view.
  const captureOptions = {
    type: "png" as const,
    scale: "css" as const,
    omitBackground: options.transparent === true,
    timeout: limits.timeoutMs,
    animations: "allow" as const,
  };
  const bytes = handle
    ? await handle.screenshot(captureOptions)
    : await page.screenshot({
        ...captureOptions,
        fullPage: scope === "fullPage",
      });
  check(signal);
  if (bytes.length > limits.maxBytes)
    throw new Error("Screenshot byte limit exceeded; no artifact was saved.");
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("Screenshot returned an invalid PNG.");
  const actual = geometry(
    bytes.readUInt32BE(16),
    bytes.readUInt32BE(20),
    limits,
  );
  // Geometry can change between preflight and capture; reject rather than mislabel.
  if (actual.width > size.width + 1 || actual.height > size.height + 1)
    throw new Error(
      "Screenshot geometry grew during capture; retry with a stable page.",
    );
  let artifact: Awaited<ReturnType<ArtifactStore["putBinary"]>>;
  try {
    artifact = await artifacts.putBinary(
      owner,
      (async function* () {
        yield bytes;
      })(),
      { maxBytes: limits.maxBytes, signal },
    );
  } catch (error) {
    // Store and filesystem messages can contain private paths or page-derived data.
    // Do not forward them or their causes. Preserve actionable state with fixed text.
    const message = error instanceof Error ? error.message : "";
    const quota = /^(?:Error: )?Artifact quota exceeded;/.test(message);
    const recovery = message.startsWith(
      "Artifact publication recovery could not be verified;",
    );
    const lock = message.includes("Lock cleanup also failed at ");
    throw new Error(
      `Screenshot artifact ${quota ? "quota exceeded" : "publication failed"}. ${recovery ? "Publication recovery could not be verified and the store lock was retained." : lock ? "Store lock cleanup failed." : "Publication or cleanup may be unverified."} Inspect the managed artifact store and resolve any retained lock before retrying.`,
    );
  }
  check(signal);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          scope,
          width: actual.width,
          height: actual.height,
          format: "png",
          resolution: "original",
          artifact: {
            id: artifact.id,
            bytes: artifact.bytes,
            expiresAt: artifact.expiresAt,
            ...(artifact.lockWarning
              ? {
                  warning:
                    "Screenshot was saved, but artifact store lock cleanup failed. Further store operations may be blocked; inspect ownership and resolve the retained lock manually before retrying.",
                }
              : {}),
          },
          note: "Screenshot may contain sensitive page content. Full-page capture does not intentionally scroll to load lazy content.",
        }),
      },
      {
        type: "image" as const,
        data: bytes.toString("base64"),
        mimeType: "image/png",
      },
    ],
  };
}
