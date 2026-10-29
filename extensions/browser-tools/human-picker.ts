import type { Browser, CDPSession, Frame, Page } from "playwright";

/**
 * Must synchronously quarantine the owned session before returning, then initiate
 * its closure. Keep it quarantined until closure is verified; rejection or an
 * unverified close must not allow reuse. Cleanup is asynchronous and a click may
 * already have reached the page after connection loss. This callback is not awaited.
 */
export type PickerFailureCleanup = (reason: string) => void | Promise<void>;
export type PickerMetadata = {
  tag: string;
  id: string;
  classes: string[];
  text: string;
  parent: {
    tag: string;
    id: string;
    classes: string[];
    relation: "parent" | "shadow-host";
  } | null;
  summary: string;
  summaryTruncated: boolean;
  summaryOmissions: string[];
};
export type PickerSelection = {
  handle: PickerHandle;
  metadata: PickerMetadata;
};
export type PickerResult =
  | {
      status: "selected";
      handle: PickerHandle;
      nodeName: string;
      selections: PickerSelection[];
    }
  | { status: "cancelled"; reason: string }
  | { status: "unsupported"; reason: string };

const DEADLINE = 2000;
function bounded<T>(promise: Promise<T>, ms = DEADLINE): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("picker operation timed out")),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Exact CDP object, not a selector. Callers must dispose it after use. */
export class PickerHandle {
  private disposed = false;
  private session: CDPSession;
  private objectId: string;
  private detach: () => Promise<void>;
  constructor(
    session: CDPSession,
    objectId: string,
    detach: () => Promise<void>,
  ) {
    this.session = session;
    this.objectId = objectId;
    this.detach = detach;
  }
  async isConnected(): Promise<boolean> {
    if (this.disposed) return false;
    const result = await bounded(
      this.session.send("Runtime.callFunctionOn", {
        objectId: this.objectId,
        functionDeclaration: "function(){return this.isConnected}",
        returnByValue: true,
      }),
    );
    return result.result.value === true && !result.exceptionDetails;
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await bounded(
        this.session.send("Runtime.releaseObject", { objectId: this.objectId }),
      );
    } catch {
      /* target may already be gone */
    }
    await this.detach();
  }
}

// Runs in a CDP isolated world. Never reads input/textarea/select values or URLs.
const METADATA_FUNCTION = String.raw`function() {
  const secret = /password|passwd|secret|token|credential|authorization|bearer|api[-_ ]?key|private[-_ ]?key/i;
  let truncated = false;
  const clean = (value, limit) => {
    value = String(value || '');
    if (value.length > 1024) truncated = true;
    value = value.slice(0, 1024).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (secret.test(value)) return '';
    value = value.replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, '[redacted]')
      .replace(/\b[A-Za-z0-9_+\/=-]{24,}\b/g, '[redacted]');
    if (value.length > limit) truncated = true;
    return value.slice(0, limit);
  };
  const sensitive = (el) => {
    const tag = el.localName || '';
    return /^(input|textarea|select|option|script|style|noscript)$/i.test(tag) ||
      el.isContentEditable || el.hasAttribute('data-private') ||
      secret.test((el.getAttribute('autocomplete') || '').slice(0, 512) + ' ' + (el.getAttribute('name') || '').slice(0, 512) + ' ' + (el.getAttribute('id') || '').slice(0, 512));
  };
  const hidden = (el) => {
    if (el.hasAttribute('hidden') || (el.getAttribute('aria-hidden') || '').trim().toLowerCase() === 'true') return true;
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') return true;
    // Chromium reports skipped content-visibility:auto subtrees as not visible.
    return typeof el.checkVisibility === 'function' && !el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true });
  };
  const describe = (el) => {
    const rawClasses = String(el.getAttribute?.('class') || '');
    if (rawClasses.length > 1024) truncated = true;
    const parts = rawClasses.slice(0, 1024).split(/\s+/).filter(Boolean);
    if (parts.length > 8) truncated = true;
    return { tag: clean(el.localName || el.nodeName, 32), id: clean(el.getAttribute?.('id'), 80), classes: parts.slice(0, 8).map(v => clean(v, 40)).filter(Boolean) };
  };
  const { tag, id, classes } = describe(this);
  let blocked = false, ancestor = this;
  for (let i = 0; ancestor; i++) {
    if (i >= 40 || sensitive(ancestor) || hidden(ancestor)) { blocked = true; break; }
    ancestor = ancestor.parentElement || ancestor.getRootNode()?.host || null;
  }
  const stack = blocked ? [] : [this];
  let text = '', visited = 0;
  while (stack.length && visited++ < 100 && text.length < 240) {
    const node = stack.pop();
    if (node.nodeType === 3) {
      const value = String(node.nodeValue || '');
      if (value.length > 240) truncated = true;
      text += ' ' + value.slice(0, 240); continue;
    }
    if (node.nodeType !== 1 || sensitive(node) || hidden(node)) continue;
    const children = node.childNodes;
    if (children.length > 100) truncated = true;
    for (let i = Math.min(children.length, 100) - 1; i >= 0; i--) stack.push(children[i]);
  }
  if (stack.length) truncated = true;
  text = clean(text, 160);
  const parentElement = this.parentElement;
  const parentNode = parentElement || this.getRootNode()?.host || null;
  const parent = parentNode && !sensitive(parentNode) && !hidden(parentNode)
    ? { ...describe(parentNode), relation: parentElement ? 'parent' : 'shadow-host' } : null;
  const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const summaryTag = /^[a-z][a-z0-9-]*$/i.test(tag) ? tag : 'element';
  const attrs = (id ? ' id="' + escape(id) + '"' : '') + (classes.length ? ' class="' + escape(classes.join(' ')) + '"' : '');
  // This is a synthetic element summary, not serialized DOM or an actionable selector.
  const summary = '<' + summaryTag + attrs + '>' + escape(text) + '</' + summaryTag + '>';
  return { connected: this.isConnected, metadata: { tag, id, classes, text, parent, summary, summaryTruncated: truncated,
    summaryOmissions: ['other attributes and values', 'descendant markup', 'hidden and sensitive content'] } };
}`;

type Target = {
  session: CDPSession;
  contextId: number;
  selected: (event: { backendNodeId: number }) => void;
  cancelled: () => void;
};

/**
 * Picker for a visible owned Chromium page. The default is one selection. With a
 * larger maxSelections, an aborted finishSignal completes the current selections;
 * Escape or signal abort cancels them all. Reaching maxSelections also completes.
 * Metadata is bounded and excludes form-control values; redaction is best effort,
 * not a guarantee against secrets embedded in arbitrary page text or attributes.
 * Existing frames are
 * inspected per Chromium target; same-process frames share their parent target.
 * Frame attachment, detachment, and navigation cancel the operation. There can be
 * a short interval before a new target's frame event arrives; no auto-attach input
 * shield is promised. Input before gating or after connection loss can reach a page.
 *
 * Integration MUST verify that the page belongs to an owned visible session and
 * serialize all page access, including other pickers, for the whole operation.
 * Retained handles must be disposed under the same ownership/serialization policy
 * and invalidated on navigation or session closure. On uncertain failure the
 * callback must quarantine synchronously, before the serialization lock is released.
 * The owner must not reuse the session unless closure is confirmed; avoid waiting
 * under a page lock for cleanup that itself requires that lock. This function does
 * not enforce ownership or serialization and does not await the cleanup callback.
 */
export async function pickHumanElement(options: {
  page: Page;
  browser: Browser;
  signal?: AbortSignal;
  finishSignal?: AbortSignal;
  maxSelections?: number;
  onUncertainFailure: PickerFailureCleanup;
}): Promise<PickerResult> {
  const { page, browser, signal, finishSignal, onUncertainFailure } = options;
  const maxSelections = options.maxSelections ?? 1;
  if (
    !Number.isInteger(maxSelections) ||
    maxSelections < 1 ||
    maxSelections > 20
  )
    throw new RangeError("maxSelections must be an integer from 1 to 20");
  const sessions: CDPSession[] = [];
  const subjects = new Map<CDPSession, Page | Frame>();
  const sessionDisconnects = new Map<CDPSession, () => void>();
  const detachedFrames = new Set<Frame>();
  const targets: Target[] = [];
  let root: CDPSession | undefined;
  let uncertain = false;
  let phasePending = false;
  let invalidate: (reason: string) => void = () => {};
  let notified = false;
  const notify = (reason: string) => {
    uncertain = true;
    if (!notified) {
      notified = true;
      try {
        Promise.resolve(onUncertainFailure(reason)).catch(() => {});
      } catch {
        /* callback is best effort */
      }
    }
  };
  const disconnected = () => {
    notify(
      "picker CDP or browser disconnected; input may have reached the page",
    );
    invalidate("disconnected");
  };
  const onNavigate = () => invalidate("navigation");
  const onFrame = () => invalidate("frame change");
  const onFrameDetached = (frame: Frame) => {
    detachedFrames.add(frame);
    invalidate("frame change");
  };
  const onClose = () => invalidate("page closed");
  const onAbort = () => invalidate("aborted");
  let wake: (() => void) | undefined;
  let finishRequested = finishSignal?.aborted ?? false;
  const onFinish = () => {
    finishRequested = true;
    wake?.();
  };
  let reason = "cancelled";
  let settle!: () => void;
  const stopped = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let stoppedFlag = false;
  invalidate = (why) => {
    if (!stoppedFlag) {
      stoppedFlag = true;
      reason = why;
      settle();
    }
  };
  const listeners = () => {
    page.off("framenavigated", onNavigate);
    page.off("frameattached", onFrame);
    page.off("framedetached", onFrameDetached);
    page.off("close", onClose);
    browser.off("disconnected", disconnected);
    signal?.removeEventListener("abort", onAbort);
    finishSignal?.removeEventListener("abort", onFinish);
  };
  page.on("framenavigated", onNavigate);
  page.on("frameattached", onFrame);
  page.on("framedetached", onFrameDetached);
  page.on("close", onClose);
  browser.on("disconnected", disconnected);
  signal?.addEventListener("abort", onAbort, { once: true });
  finishSignal?.addEventListener("abort", onFinish, { once: true });
  if (signal?.aborted) invalidate("aborted");
  const phase = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (stoppedFlag) throw new Error("cancelled");
    phasePending = true;
    const pending = fn().finally(() => {
      phasePending = false;
    });
    return await Promise.race([
      bounded(pending),
      stopped.then(() => {
        throw new Error("cancelled");
      }),
    ]);
  };
  const expectedRemovedFrame = (session: CDPSession) => {
    const subject = subjects.get(session);
    return (
      subject !== undefined &&
      subject !== page &&
      detachedFrames.has(subject as Frame) &&
      (subject as Frame).isDetached() &&
      browser.isConnected() &&
      !page.isClosed()
    );
  };
  const expectedClosedChild = (session: CDPSession, error: unknown) =>
    expectedRemovedFrame(session) &&
    error instanceof Error &&
    /(?:Target page, context or browser has been closed|Session closed)/i.test(
      error.message,
    );
  const detach = async (session: CDPSession) => {
    const listener = sessionDisconnects.get(session);
    if (listener) session.off("Disconnected", listener);
    try {
      await bounded(session.detach());
    } catch (error) {
      if (!expectedClosedChild(session, error))
        notify("picker CDP detach could not be verified");
    }
  };
  const acquire = async (
    subject: Page | Frame,
  ): Promise<CDPSession | undefined> => {
    if (stoppedFlag) throw new Error("cancelled");
    const acquisition = page.context().newCDPSession(subject);
    try {
      const session = await phase(() => acquisition);
      sessions.push(session);
      subjects.set(session, subject);
      const onDisconnected = () => {
        if (expectedRemovedFrame(session)) invalidate("frame change");
        else disconnected();
      };
      sessionDisconnects.set(session, onDisconnected);
      session.on("Disconnected", onDisconnected);
      return session;
    } catch (error) {
      if (
        !phasePending &&
        !stoppedFlag &&
        subject !== page &&
        error instanceof Error &&
        error.message.includes("does not have a separate CDP session")
      )
        return undefined;
      if (phasePending || stoppedFlag) {
        notify(
          "picker CDP session acquisition was abandoned; owned cleanup is required",
        );
        void acquisition.then(
          (late) =>
            bounded(Promise.resolve().then(() => late.detach())).catch(() => {
              notify("late picker CDP session detach could not be verified");
            }),
          () => {},
        );
      }
      throw error;
    }
  };
  const queue: { target: Target; backendNodeId: number }[] = [];
  const records: {
    session: CDPSession;
    objectId: string;
    metadata: PickerMetadata;
  }[] = [];
  let capturing = 0;
  let keep = new Set<CDPSession>();
  const arm = async (session: CDPSession) => {
    await phase(() => session.send("DOM.enable"));
    await phase(() => session.send("Overlay.enable"));
    const tree = await phase(() => session.send("Page.getFrameTree"));
    const world = await phase(() =>
      session.send("Page.createIsolatedWorld", {
        frameId: tree.frameTree.frame.id,
        worldName: "pi-human-picker",
      }),
    );
    const target: Target = {
      session,
      contextId: world.executionContextId,
      selected: (event) => {
        if (stoppedFlag || finishRequested) return;
        if (queue.length + records.length + capturing >= maxSelections) {
          invalidate("selection event limit exceeded");
          return;
        }
        queue.push({ target, backendNodeId: event.backendNodeId });
        wake?.();
      },
      cancelled: () => invalidate("escape"),
    };
    targets.push(target);
    session.on("Overlay.inspectNodeRequested", target.selected);
    session.on("Overlay.inspectModeCanceled", target.cancelled);
    await phase(() =>
      session.send("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: { showInfo: true },
      }),
    );
  };
  try {
    if (!stoppedFlag) {
      root = await acquire(page);
      if (!root) throw new Error("root CDP session unavailable");
      await phase(() =>
        root!.send("Input.setIgnoreInputEvents", { ignore: true }),
      );
      const frames = page.frames();
      await arm(root);
      for (const frame of frames) {
        if (frame === page.mainFrame()) continue;
        const child = await acquire(frame);
        if (child) await arm(child);
      }
      // Every frame change after listener installation invalidates this snapshot.
      if (
        page.frames().length !== frames.length ||
        frames.some((frame) => !page.frames().includes(frame))
      )
        invalidate("frame change");
      await phase(() =>
        root!.send("Input.setIgnoreInputEvents", { ignore: false }),
      );
      while (!stoppedFlag && records.length < maxSelections) {
        if (!queue.length) {
          if (finishRequested) break;
          const changed = new Promise<void>((resolve) => {
            wake = resolve;
          });
          await Promise.race([changed, stopped]);
          wake = undefined;
          continue;
        }
        const selected = queue.shift()!;
        capturing = 1;
        await phase(() =>
          root!.send("Input.setIgnoreInputEvents", { ignore: true }),
        );
        const session = selected.target.session;
        const resolved = await phase(() =>
          session.send("DOM.resolveNode", {
            backendNodeId: selected.backendNodeId,
            executionContextId: selected.target.contextId,
          }),
        );
        if (!resolved.object.objectId)
          throw new Error("selected node could not be retained");
        const objectId = resolved.object.objectId;
        const info = await phase(() =>
          session.send("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: METADATA_FUNCTION,
            returnByValue: true,
          }),
        );
        if (
          info.exceptionDetails ||
          !info.result.value?.connected ||
          !info.result.value?.metadata
        )
          throw new Error(
            "selected node is no longer connected or could not be described",
          );
        records.push({
          session,
          objectId,
          metadata: info.result.value.metadata as PickerMetadata,
        });
        capturing = 0;
        if (records.length < maxSelections && !finishRequested)
          await phase(() =>
            root!.send("Input.setIgnoreInputEvents", { ignore: false }),
          );
      }
      if (!stoppedFlag && !records.length)
        invalidate("finished without selection");
      for (const record of records) {
        if (stoppedFlag) break;
        const check = await phase(() =>
          record.session.send("Runtime.callFunctionOn", {
            objectId: record.objectId,
            functionDeclaration: "function(){return this.isConnected}",
            returnByValue: true,
          }),
        );
        if (check.exceptionDetails || check.result.value !== true)
          throw new Error("selected node is no longer connected");
      }
      if (!stoppedFlag) keep = new Set(records.map((record) => record.session));
    }
  } catch (error) {
    if (!stoppedFlag) {
      reason = error instanceof Error ? error.message : "picker failed";
      invalidate(reason);
    }
    if (phasePending)
      notify(
        "picker operation remained pending during cancellation or failure",
      );
  } finally {
    if (root) {
      try {
        await bounded(
          root.send("Input.setIgnoreInputEvents", { ignore: true }),
        );
        await bounded(
          Promise.all(
            sessions.map(async (session) => {
              try {
                await session.send("Overlay.setInspectMode", {
                  mode: "none",
                  highlightConfig: {},
                });
              } catch (error) {
                if (!expectedClosedChild(session, error)) throw error;
              }
            }),
          ),
        );
        await bounded(
          root.send("Input.setIgnoreInputEvents", { ignore: false }),
        );
      } catch {
        notify("picker teardown could not be verified");
      }
    }
    for (const target of targets) {
      target.session.off("Overlay.inspectNodeRequested", target.selected);
      target.session.off("Overlay.inspectModeCanceled", target.cancelled);
    }
    if (stoppedFlag || uncertain) keep.clear();
    await Promise.all(
      sessions.filter((session) => !keep.has(session)).map(detach),
    );
    if (uncertain && keep.size) {
      await Promise.all([...keep].map(detach));
      keep.clear();
    }
    for (const session of keep) {
      const listener = sessionDisconnects.get(session);
      if (listener) session.off("Disconnected", listener);
    }
    listeners();
  }
  if (keep.size && records.length) {
    const counts = new Map<CDPSession, number>();
    for (const record of records)
      counts.set(record.session, (counts.get(record.session) ?? 0) + 1);
    const selections = records.map(({ session, objectId, metadata }) => ({
      metadata,
      handle: new PickerHandle(session, objectId, async () => {
        const remaining = (counts.get(session) ?? 1) - 1;
        counts.set(session, remaining);
        if (!remaining) await detach(session);
      }),
    }));
    return {
      status: "selected",
      handle: selections[0].handle,
      nodeName: selections[0].metadata.tag.toUpperCase(),
      selections,
    };
  }
  return {
    status: "cancelled",
    reason: uncertain ? `${reason}; cleanup uncertain` : reason,
  };
}
