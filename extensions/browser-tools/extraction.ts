import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { CDPSession, Page } from "playwright";
import type { ArtifactStore } from "./artifacts.ts";
import { inspectionOutput } from "./output.ts";
import { sanitizeUrl } from "./redaction.ts";
import type { SessionTarget } from "./sessions.ts";

export const EXTRACTION_TOOL_NAMES = ["browser_extract"] as const;
type Target = Partial<SessionTarget>;
type Scope = { frameSelector?: string; selector?: string };
type RequestedUrl =
  | string
  | null
  | ((identity: { loaderId: string; url: string }) => string | null);

// Fail closed rather than returning an apparently complete partial page. These limits
// bound our own traversal and host processing, not browser layout/selector costs.
const LIMITS = { nodes: 4000, chars: 256 * 1024, depth: 128, metadata: 8192 };
type Item = {
  kind: "open" | "close" | "text";
  tag?: string;
  value?: string;
  href?: string | null;
};
type Snapshot = {
  items: Item[];
  title: string | null;
  url: string;
  base: string;
  retrievedAt: number;
};

async function evaluate(
  cdp: CDPSession,
  contextId: number,
  expression: string,
  returnByValue: boolean,
) {
  const result = await cdp.send("Runtime.evaluate", {
    contextId,
    expression,
    returnByValue,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw new Error(
      "Browser extraction failed: " +
        (
          result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text
        ).slice(0, 500),
    );
  return result.result;
}

// Runs in a Chromium isolated world, not the page's script world. It never clones
// or mutates DOM nodes, constructs elements, calls page-owned JS, or scrolls.
function capture(
  selector: string | undefined,
  limits: typeof LIMITS,
): Snapshot {
  const retrievedAt = Date.now();
  let root: Element = document.body;
  if (!root) throw new Error("Document has no accessible content.");
  const hidden = (el: Element) => {
    const style = getComputedStyle(el);
    return (
      el.hasAttribute("hidden") ||
      el.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    );
  };
  let visited = 0;
  if (selector !== undefined) {
    // Bound the document before materializing a native selector result. Native
    // document selector semantics are required for :scope and selector lists.
    let current: Node | null = document.documentElement;
    while (current) {
      if (++visited > limits.nodes)
        throw new Error(
          "Extraction node limit exceeded while resolving selector; narrow content using DOM/eval.",
        );
      if (current.firstChild) {
        current = current.firstChild;
        continue;
      }
      while (current && !current.nextSibling) current = current.parentNode;
      current = current?.nextSibling ?? null;
    }
    const matches = document.querySelectorAll(selector);
    if (matches.length !== 1)
      throw new Error("Scope selector must match exactly one element.");
    root = matches[0];
  }
  for (let el: Element | null = root; el; el = el.parentElement) {
    if (hidden(el))
      throw new Error("Selected content is hidden or unavailable.");
  }
  const items: Item[] = [];
  let chars = 0;
  const check = (s: string) => {
    chars += s.length;
    if (chars > limits.chars)
      throw new Error(
        "Extraction text limit exceeded; use DOM/eval for explicit access.",
      );
    return s;
  };
  const metadata = (s: string) => {
    if (s.length > limits.metadata)
      throw new Error("Extraction metadata limit exceeded.");
    return s;
  };
  const excluded = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "IFRAME",
    "FRAME",
    "INPUT",
    "TEXTAREA",
    "SELECT",
    "BUTTON",
    "IMG",
    "SVG",
    "CANVAS",
  ]);
  // Events allow incremental output without serializing HTML or instantiating elements.
  const stack: { node: Node; close: boolean; depth: number }[] = [
    { node: root, close: false, depth: 0 },
  ];
  visited = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    const node = entry.node;
    if (entry.close) {
      items.push({
        kind: "close",
        tag: (node as Element).tagName.toLowerCase(),
      });
      continue;
    }
    if (++visited > limits.nodes || entry.depth > limits.depth)
      throw new Error(
        "Extraction node or depth limit exceeded; use DOM/eval for explicit access.",
      );
    if (node.nodeType === 3) {
      const value = check(node.nodeValue ?? "");
      if (value) items.push({ kind: "text", value });
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    if (excluded.has(el.tagName) || hidden(el)) continue;
    const tag = el.tagName.toLowerCase();
    let href: string | null = null;
    if (tag === "a") {
      const attr = el.getAttribute("href");
      if (attr !== null) href = check(attr);
    }
    items.push({ kind: "open", tag, href });
    stack.push({ node, close: true, depth: entry.depth });
    // Limit the stack as well as visited nodes; do not build an unbounded array.
    for (let child = node.lastChild; child; child = child.previousSibling) {
      if (stack.length + visited > limits.nodes)
        throw new Error(
          "Extraction node limit exceeded; use DOM/eval for explicit access.",
        );
      stack.push({ node: child, close: false, depth: entry.depth + 1 });
    }
  }
  return {
    items,
    title: document.title ? metadata(document.title) : null,
    url: metadata(location.href),
    base: metadata(document.baseURI),
    retrievedAt,
  };
}

// Resolve an explicit iframe with isolated-world native DOM methods. The caller
// maps its object to a CDP frame ID and fails if Chromium cannot access it.
function selectFrame(selector: string, limit: number): Element {
  let current: Node | null = document.documentElement;
  let count = 0;
  while (current) {
    if (++count > limit)
      throw new Error(
        "Extraction node limit exceeded while resolving frame selector.",
      );
    if (current.firstChild) {
      current = current.firstChild;
      continue;
    }
    while (current && !current.nextSibling) current = current.parentNode;
    current = current?.nextSibling ?? null;
  }
  const matches = document.querySelectorAll(selector);
  if (matches.length !== 1 || !["IFRAME", "FRAME"].includes(matches[0].tagName))
    throw new Error("Frame selector must match exactly one iframe or frame.");
  for (let el: Element | null = matches[0]; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (
      el.hasAttribute("hidden") ||
      el.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      throw new Error("Selected frame is hidden or unavailable.");
  }
  return matches[0];
}

function provenanceUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:")
      return sanitizeUrl(value);
    if (
      url.protocol === "about:" &&
      (url.pathname === "blank" || url.pathname === "srcdoc")
    )
      return `about:${url.pathname}${url.search ? "?[redacted]" : ""}${url.hash ? "#[redacted]" : ""}`;
    return `${url.protocol}[redacted]`;
  } catch {
    return "[invalid URL]";
  }
}
function safeText(value: string): string {
  // Presentation redaction, not a general secret detector. Visible page text is
  // untrusted and may still contain secrets unrelated to recognizable URLs.
  return value.replace(/https?:\/\/[^\s<>"'\])}]+/gi, (url) =>
    sanitizeUrl(url),
  );
}
function safeLink(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:"
      ? sanitizeUrl(url.href)
      : null;
  } catch {
    return null;
  }
}
function render(snapshot: Snapshot, requestedUrl: string | null, scope: Scope) {
  let text = "";
  const headings: { level: number; text: string }[] = [];
  const links: { text: string; url: string }[] = [];
  const openHeadings: { level: number; start: number }[] = [];
  const openLinks: { url: string | null; start: number }[] = [];
  const block = new Set([
    "p",
    "div",
    "section",
    "article",
    "main",
    "header",
    "footer",
    "li",
    "pre",
    "blockquote",
    "br",
    "tr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
  ]);
  for (const item of snapshot.items) {
    const tag = item.tag ?? "";
    if (item.kind === "text") {
      text += safeText(item.value!);
      continue;
    }
    if (item.kind === "open") {
      if (block.has(tag) && text && !text.endsWith("\n")) text += "\n";
      if (/^h[1-6]$/.test(tag))
        openHeadings.push({ level: Number(tag[1]), start: text.length });
      if (tag === "a")
        openLinks.push({
          url: item.href ? safeLink(item.href, snapshot.base) : null,
          start: text.length,
        });
    } else {
      if (/^h[1-6]$/.test(tag)) {
        const heading = openHeadings.pop()!;
        const value = text.slice(heading.start).replace(/\s+/g, " ").trim();
        if (value) headings.push({ level: heading.level, text: value });
      }
      if (tag === "a") {
        const link = openLinks.pop()!;
        if (link.url)
          links.push({
            text: text.slice(link.start).replace(/\s+/g, " ").trim(),
            url: link.url,
          });
      }
      if (block.has(tag) && text && !text.endsWith("\n")) text += "\n";
    }
  }
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("Selected content contains no readable text.");
  return {
    title: snapshot.title === null ? null : safeText(snapshot.title),
    requestedUrl: requestedUrl === null ? null : provenanceUrl(requestedUrl),
    finalUrl: provenanceUrl(snapshot.url),
    retrievedAt: new Date(snapshot.retrievedAt).toISOString(),
    publicationTime: null,
    method: scope.selector === undefined ? "document" : "selector",
    headings,
    links,
    text,
    omissions:
      "Content hidden at snapshot time, interactive fields, images, embedded documents, scripts, and shadow roots are omitted. Selected frame visibility is checked before and after capture, not continuously. URL credential fields are redacted; visible text may contain other secrets. Use DOM/eval for explicit raw access.",
  };
}

/** Captures one bounded current document; unavailable frames and limit overruns fail closed. */
export async function extractPage(
  page: Page,
  scope: Scope = {},
  requestedUrl: RequestedUrl = null,
) {
  const cdp = await page.context().newCDPSession(page);
  let childCdp: CDPSession | undefined;
  try {
    const tree = await cdp.send("Page.getFrameTree");
    let frameId = tree.frameTree.frame.id;
    const world = async (session: CDPSession, id: string) =>
      (
        await session.send("Page.createIsolatedWorld", {
          frameId: id,
          worldName: "pi-browser-extraction",
        })
      ).executionContextId;
    let activeCdp = cdp;
    let contextId = await world(cdp, frameId);
    const parentContextId = contextId;
    if (scope.frameSelector !== undefined) {
      const selected = await evaluate(
        cdp,
        contextId,
        `(${selectFrame.toString()})(${JSON.stringify(scope.frameSelector)},${LIMITS.nodes})`,
        false,
      );
      if (!selected.objectId) throw new Error("Selected frame is unavailable.");
      const node = await cdp.send("DOM.describeNode", {
        objectId: selected.objectId,
      });
      if (!node.node.frameId)
        throw new Error("Selected frame is inaccessible.");
      frameId = node.node.frameId;
      try {
        contextId = await world(cdp, frameId);
      } catch (error) {
        if (!String(error).includes("No frame for given id found")) throw error;
        // OOPIFs require a target-specific session. Resolve through Playwright's
        // public frame API and verify its CDP frame identity before reading it.
        const locator = page.locator(`css=${scope.frameSelector}`);
        if ((await locator.count()) !== 1)
          throw new Error("Selected frame changed during extraction.");
        const handle = await locator.elementHandle({ timeout: 1000 });
        let frame;
        try {
          frame = await handle?.contentFrame();
        } finally {
          await handle?.dispose();
        }
        if (!frame) throw new Error("Selected frame became inaccessible.");
        childCdp = await page.context().newCDPSession(frame);
        const childTree = await childCdp.send("Page.getFrameTree");
        if (childTree.frameTree.frame.id !== frameId)
          throw new Error("Selected frame changed during extraction.");
        activeCdp = childCdp;
        contextId = await world(activeCdp, frameId);
      }
      requestedUrl = null;
    }
    const result = await evaluate(
      activeCdp,
      contextId,
      `(${capture.toString()})(${JSON.stringify(scope.selector ?? null)} === null ? undefined : ${JSON.stringify(scope.selector ?? null)},${JSON.stringify(LIMITS)})`,
      true,
    );
    if (scope.frameSelector !== undefined) {
      const selected = await evaluate(
        cdp,
        parentContextId,
        `(${selectFrame.toString()})(${JSON.stringify(scope.frameSelector)},${LIMITS.nodes})`,
        false,
      );
      if (!selected.objectId) throw new Error("Selected frame is unavailable.");
      const node = await cdp.send("DOM.describeNode", {
        objectId: selected.objectId,
      });
      if (node.node.frameId !== frameId)
        throw new Error("Selected frame changed during extraction.");
    }
    const snapshot = result.value as Snapshot;
    if (typeof requestedUrl === "function") {
      const finalFrame = (await cdp.send("Page.getFrameTree")).frameTree.frame;
      const initialFrame = tree.frameTree.frame;
      const initialUrl = initialFrame.url + (initialFrame.urlFragment ?? "");
      const finalUrl = finalFrame.url + (finalFrame.urlFragment ?? "");
      requestedUrl =
        initialFrame.id === finalFrame.id &&
        initialFrame.loaderId &&
        initialFrame.loaderId === finalFrame.loaderId &&
        initialUrl === finalUrl &&
        finalUrl === snapshot.url
          ? requestedUrl({ loaderId: finalFrame.loaderId, url: finalUrl })
          : null;
    }
    return render(snapshot, requestedUrl, scope);
  } finally {
    await childCdp?.detach().catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

/**
 * Integration contract: runPage must resolve the selected owned tab and run the
 * callback inside ManagedSessions' existing serialized/cancellable run guard.
 * The requested URL resolver must verify the supplied main-document loader and URL
 * against current navigation state and return null on uncertainty; never reuse stale input.
 * The caller owns activation, shutdown, owner and timeout signal composition.
 */
export function registerExtractionTools(
  pi: ExtensionAPI,
  getRuntime: (
    ctx: ExtensionContext | undefined,
    signal?: AbortSignal,
  ) => {
    artifacts: ArtifactStore;
    owner: string;
    signal?: AbortSignal;
    runPage: <T>(
      target: Target,
      signal: AbortSignal | undefined,
      work: (
        page: Page,
        target: SessionTarget,
        requestedUrl: RequestedUrl,
      ) => Promise<T>,
    ) => Promise<T>;
  },
) {
  pi.registerTool({
    name: "browser_extract",
    label: "Browser extract",
    description:
      "Extract one current rendered document or explicitly scoped element as untrusted research content. No crawling. Bounded snapshot; oversize content fails. URL credentials are redacted; use DOM/eval for explicit raw access. Large complete records use private artifacts.",
    parameters: Type.Object({
      sessionId: Type.Optional(Type.String({ maxLength: 256 })),
      tabId: Type.Optional(Type.String({ maxLength: 256 })),
      frameSelector: Type.Optional(
        Type.String({ minLength: 1, maxLength: 2048 }),
      ),
      selector: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx, signal);
      const { target, record } = await runtime.runPage(
        { sessionId: args.sessionId, tabId: args.tabId },
        runtime.signal,
        async (page, target, requestedUrl) => ({
          target,
          record: await extractPage(
            page,
            { frameSelector: args.frameSelector, selector: args.selector },
            requestedUrl,
          ),
        }),
      );
      const output = await inspectionOutput(
        runtime.artifacts,
        runtime.owner,
        JSON.stringify(record),
        {
          target,
          scope: "one selected document or element",
          representation: "research-record-json",
          untrusted: true,
        },
        runtime.signal,
      );
      return {
        content: [{ type: "text" as const, text: output }],
        details: undefined,
      };
    },
  });
}
