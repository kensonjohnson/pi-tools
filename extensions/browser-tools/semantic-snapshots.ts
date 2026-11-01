import { randomUUID } from "node:crypto";
import type { ElementHandle, Frame, Page } from "playwright";
import { sanitizeUrl } from "./redaction.ts";

function boundedText(
  value: string,
  bytes: number,
): { text: string; truncated: boolean } {
  const chars = Array.from(value);
  let lo = 0,
    hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (
      Buffer.byteLength(JSON.stringify(chars.slice(0, mid).join("")), "utf8") <=
      bytes
    )
      lo = mid;
    else hi = mid - 1;
  }
  return { text: chars.slice(0, lo).join(""), truncated: lo < chars.length };
}
function safeUrl(value: string): string {
  if (value.length > 4096) return "[URL omitted: too long]";
  return sanitizeUrl(value);
}

export type SemanticRecord = {
  ref?: string;
  frame: string;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
};
export type SemanticSnapshot = {
  title: string;
  url: string;
  records: SemanticRecord[];
  omitted: string[];
};
type IdentityBudget = {
  nameChars: number;
  textChars: number;
  nodes: number;
  ancestors: number;
  frameDepth: number;
  metadataChars: number;
  labels: number;
};
type Entry = {
  handle: ElementHandle;
  frame: Frame;
  fingerprint: string;
  identity: IdentityBudget;
};

function frameVisible(
  el: Element,
  maxAncestors: number,
): "visible" | "hidden" | "ancestor_limit" {
  if (!el.isConnected) return "hidden";
  let current: Element | null = el;
  let depth = 0;
  while (current && depth++ < maxAncestors) {
    const style = getComputedStyle(current);
    if (
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.contentVisibility === "hidden" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return "hidden";
    const root = current.getRootNode();
    current =
      current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return current === null ? "visible" : "ancestor_limit";
}
async function visibleFrameChain(
  frame: Frame,
  identity: IdentityBudget,
): Promise<"visible" | "hidden" | "ancestor_limit" | "frame_limit"> {
  let current: Frame | null = frame;
  let depth = 0;
  while (current?.parentFrame()) {
    if (++depth > identity.frameDepth) return "frame_limit";
    const element = await current.frameElement();
    try {
      if (!(await element.isVisible())) return "hidden";
      const state = await element.evaluate(frameVisible, identity.ancestors);
      if (state !== "visible") return state;
    } finally {
      await element.dispose();
    }
    current = current.parentFrame();
  }
  return "visible";
}

// This runs as one renderer task: the metadata and node references describe the
// same traversal. It intentionally does not claim the full accessibility algorithm.
function collect(args: {
  selector?: string;
  nodes: number;
  records: number;
  chars: number;
  scopeNodes: number;
  identity: IdentityBudget;
}) {
  const native = (f: unknown) =>
    typeof f === "function" &&
    Function.prototype.toString.call(f).includes("[native code]");
  const typeGetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "type",
  )?.get;
  const valueGetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.get;
  const textareaValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.get;
  const selectValue = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.get;
  const safeValues =
    native(typeGetter) &&
    native(valueGetter) &&
    native(textareaValue) &&
    native(selectValue) &&
    native(Element.prototype.getAttribute) &&
    native(window.getComputedStyle);
  if (
    !native(Function.prototype.toString) ||
    !native(typeGetter) ||
    !native(Element.prototype.getAttribute) ||
    !native(window.getComputedStyle)
  )
    throw new Error("Cannot safely determine input types or visibility.");
  let root: Element | null = document.body;
  let idScope = false;
  if (args.selector) {
    // Exact simple IDs use the browser's first-match lookup without scanning the page.
    // Duplicate ID detection cannot be bounded on an arbitrary document.
    if (/^#[A-Za-z_][A-Za-z0-9_-]*$/.test(args.selector)) {
      idScope = true;
      root = document.getElementById(args.selector.slice(1));
      if (!root) throw new Error("Scope selector did not match an element.");
    } else {
      let current: Node | null = document.documentElement;
      let inspected = 0;
      while (current) {
        if (++inspected > args.scopeNodes)
          throw new Error(
            "Scope resolution node limit exceeded; use an exact ID or DOM inspection.",
          );
        if (current.firstChild) {
          current = current.firstChild;
          continue;
        }
        while (current && !current.nextSibling) current = current.parentNode;
        current = current?.nextSibling ?? null;
      }
      const matches = document.querySelectorAll(args.selector);
      if (matches.length !== 1)
        throw new Error("Scope selector must match exactly one element");
      root = matches[0];
    }
    let parentDepth = 0;
    for (
      let parent: Element | null = root;
      parent;
      parent = parent.parentElement
    ) {
      if (++parentDepth > args.identity.ancestors)
        throw new Error("Scope ancestor limit exceeded.");
      const style = getComputedStyle(parent);
      if (
        parent.hasAttribute("hidden") ||
        parent.getAttribute("aria-hidden") === "true" ||
        style.contentVisibility === "hidden" ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      )
        throw new Error("Scope is hidden.");
    }
  }
  // Incomplete names cannot safely bind a reference to semantic identity.
  let incompleteIdentity = false;
  // Read visible text without collecting form values or script text.
  const visibleText = (element: Element): string => {
    let ancestor: Element | null = element;
    let depth = 0;
    while (ancestor && depth++ < args.identity.ancestors) {
      const style = getComputedStyle(ancestor);
      if (
        ancestor.hasAttribute("hidden") ||
        ancestor.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.contentVisibility === "hidden" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      )
        return "";
      const root = ancestor.getRootNode();
      ancestor =
        ancestor.parentElement ??
        (root instanceof ShadowRoot ? root.host : null);
    }
    if (ancestor) {
      incompleteIdentity = true;
      return "";
    }
    const pending: Node[] = [element];
    let text = "",
      visited = 0;
    while (
      pending.length &&
      visited++ < args.identity.nodes &&
      text.length < args.identity.textChars
    ) {
      const node = pending.pop()!;
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.nodeValue || "";
        const part = ` ${value}`;
        const remaining = args.identity.textChars - text.length;
        if (part.length > remaining) incompleteIdentity = true;
        text += part.slice(0, remaining);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const item = node as Element;
      if (
        [
          "SCRIPT",
          "STYLE",
          "NOSCRIPT",
          "TEMPLATE",
          "INPUT",
          "TEXTAREA",
          "SELECT",
        ].includes(item.tagName)
      )
        continue;
      const style = getComputedStyle(item);
      if (
        item.hasAttribute("hidden") ||
        item.getAttribute("aria-hidden") === "true" ||
        style.contentVisibility === "hidden" ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      )
        continue;
      for (let child = item.lastChild; child; child = child.previousSibling) {
        if (pending.length >= args.identity.nodes) {
          incompleteIdentity = true;
          break;
        }
        pending.push(child);
      }
    }
    if (pending.length) incompleteIdentity = true;
    return text;
  };
  const attr = (el: Element, name: string) => {
    const value = el.getAttribute(name);
    if (value !== null && value.length > args.identity.metadataChars)
      throw new Error(
        `Snapshot ${name} metadata exceeds limit; narrow or inspect with DOM.`,
      );
    return value;
  };
  const records: Array<{
    node?: Element;
    role: string;
    name: string;
    value?: string;
    checked?: boolean;
    disabled?: boolean;
    fingerprint?: string;
  }> = [];
  let count = 0,
    chars = 0,
    truncated = false,
    clipped = 0,
    oversized = 0,
    incompleteNames = 0,
    visual = false;
  const stack: { node: Node; suppressText: boolean }[] = root
    ? [{ node: root, suppressText: false }]
    : [];
  while (stack.length) {
    if (
      count >= args.nodes ||
      records.length >= args.records ||
      chars >= args.chars
    ) {
      truncated = true;
      break;
    }
    count++;
    const { node, suppressText } = stack.pop()!;
    if (node.nodeType === Node.TEXT_NODE) {
      if (!suppressText) {
        const raw = node.nodeValue || "";
        if (raw.length > 1024) clipped++;
        const text = raw.slice(0, 1024).replace(/\s+/g, " ").trim();
        if (text) {
          if (text.length > 240) clipped++;
          const name = text.slice(0, 240);
          chars += name.length + 128;
          records.push({ role: "text", name });
        }
      }
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    const style = getComputedStyle(el);
    if (
      el.hasAttribute("hidden") ||
      el.getAttribute("aria-hidden") === "true" ||
      style.contentVisibility === "hidden" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      continue;
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "template", "noscript"].includes(tag)) continue;
    if (["canvas", "svg"].includes(tag)) visual = true;
    const input = tag === "input" ? (el as HTMLInputElement) : null;
    const type = input ? (typeGetter!.call(input) as string).toLowerCase() : "";
    if (input && type === "hidden") continue;
    // An oversized field cannot safely participate in a fingerprint. Skip this
    // subtree rather than retaining a reference that cannot be revalidated.
    if (
      ["role", "aria-labelledby", "aria-label", "alt", "title", "href"].some(
        (name) =>
          (el.getAttribute(name)?.length ?? 0) > args.identity.metadataChars,
      )
    ) {
      oversized++;
      continue;
    }
    const explicit = attr(el, "role");
    const role =
      explicit ||
      (tag === "button"
        ? "button"
        : tag === "a" && el.hasAttribute("href")
          ? "link"
          : /^h[1-6]$/.test(tag)
            ? "heading"
            : tag === "textarea"
              ? "textbox"
              : tag === "select"
                ? "combobox"
                : input
                  ? ["checkbox", "radio", "button", "submit", "reset"].includes(
                      type,
                    )
                    ? type === "submit" || type === "reset"
                      ? "button"
                      : type
                    : "textbox"
                  : "");
    if (role) {
      incompleteIdentity = false;
      let identityAncestor: Element | null = el;
      let identityDepth = 0;
      while (identityAncestor) {
        if (++identityDepth > args.identity.ancestors) {
          incompleteIdentity = true;
          break;
        }
        const ancestorStyle = getComputedStyle(identityAncestor);
        if (
          identityAncestor.hasAttribute("hidden") ||
          identityAncestor.getAttribute("aria-hidden") === "true" ||
          ancestorStyle.display === "none" ||
          ancestorStyle.contentVisibility === "hidden" ||
          ancestorStyle.visibility === "hidden" ||
          ancestorStyle.visibility === "collapse"
        ) {
          incompleteIdentity = true;
          break;
        }
        const ancestorRoot = identityAncestor.getRootNode();
        identityAncestor =
          identityAncestor.parentElement ??
          (ancestorRoot instanceof ShadowRoot ? ancestorRoot.host : null);
      }
      const labelled = attr(el, "aria-labelledby");
      const ids = labelled ? labelled.trim().split(/\s+/) : [];
      if (
        ids.length > args.identity.labels ||
        (input?.labels?.length ?? 0) > args.identity.labels
      ) {
        oversized++;
        continue;
      }
      const root = el.getRootNode();
      const labelText = ids
        .map((id) => {
          const label =
            root instanceof Document || root instanceof ShadowRoot
              ? root.getElementById(id)
              : null;
          return label ? visibleText(label) : "";
        })
        .join(" ");
      const labels = input?.labels
        ? Array.from(input.labels)
            .map((l) => visibleText(l))
            .join(" ")
        : "";
      const rawName = (
        attr(el, "aria-label") ||
        labelText ||
        labels ||
        attr(el, "alt") ||
        attr(el, "title") ||
        (safeValues && input && ["submit", "button", "reset"].includes(type)
          ? (() => {
              const value = String(valueGetter!.call(input));
              if (value.length > args.identity.metadataChars)
                incompleteIdentity = true;
              return value.slice(0, args.identity.metadataChars);
            })()
          : "") ||
        visibleText(el) ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      if (rawName.length > args.identity.nameChars) {
        clipped++;
        incompleteIdentity = true;
      }
      const name = rawName.slice(0, args.identity.nameChars);
      const fingerprint = JSON.stringify([
        tag,
        type,
        role,
        name,
        attr(el, "href"),
      ]);
      const record: (typeof records)[number] = {
        ...(incompleteIdentity ? {} : { node: el, fingerprint }),
        role,
        name,
      };
      if (incompleteIdentity) incompleteNames++;
      const boundedValue = (value: string) => {
        if (value.length > 240) clipped++;
        return value.slice(0, 240);
      };
      if (
        safeValues &&
        input &&
        !["password", "hidden", "submit", "button", "reset", "file"].includes(
          type,
        )
      )
        record.value = boundedValue(String(valueGetter!.call(input)));
      if (safeValues && tag === "textarea")
        record.value = boundedValue(String(textareaValue!.call(el)));
      if (safeValues && tag === "select")
        record.value = boundedValue(String(selectValue!.call(el)));
      if (input && ["checkbox", "radio"].includes(type))
        record.checked = input.checked;
      if ("disabled" in el)
        record.disabled = Boolean((el as HTMLInputElement).disabled);
      chars += name.length + (record.value?.length || 0) + 128;
      records.push(record);
    }
    if (["iframe", "frame", "input", "textarea", "select"].includes(tag))
      continue;
    const suppressChildren =
      suppressText ||
      [
        "heading",
        "button",
        "link",
        "textbox",
        "combobox",
        "checkbox",
        "radio",
      ].includes(role);
    for (let child = el.lastChild; child; child = child.previousSibling) {
      if (stack.length + count >= args.nodes) {
        truncated = true;
        break;
      }
      stack.push({ node: child, suppressText: suppressChildren });
    }
    if (el.shadowRoot)
      for (
        let child = el.shadowRoot.lastChild;
        child;
        child = child.previousSibling
      ) {
        if (stack.length + count >= args.nodes) {
          truncated = true;
          break;
        }
        stack.push({
          node: child,
          suppressText: suppressChildren,
        });
      }
  }
  return {
    records,
    truncated,
    pending: stack.length,
    clipped,
    oversized,
    incompleteNames,
    idScope,
    visual,
    safeValues,
  };
}

/** One instance belongs to one owner and page. Serialize callers externally. */
export class SemanticSnapshots {
  private entries = new Map<string, Entry>();
  private generation = 0;
  private closed = false;
  private readonly invalidate = () => {
    void this.clear();
  };
  private readonly page: Page;
  constructor(page: Page) {
    this.page = page;
    page.on("framenavigated", this.invalidate);
    page.on("framedetached", this.invalidate);
    page.on("close", this.invalidate);
  }
  async clear() {
    this.generation++;
    const old = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(old.map((e) => e.handle.dispose().catch(() => {})));
  }
  async dispose() {
    this.closed = true;
    this.page.off("framenavigated", this.invalidate);
    this.page.off("framedetached", this.invalidate);
    this.page.off("close", this.invalidate);
    await this.clear();
  }
  async snapshot(
    options: {
      selector?: string;
      frame?: Frame;
      maxNodes?: number;
      maxRecords?: number;
      maxChars?: number;
      maxFrames?: number;
      maxScopeNodes?: number;
      identityNameChars?: number;
      identityTextChars?: number;
      identityNodes?: number;
      identityAncestors?: number;
      identityFrameDepth?: number;
      identityMetadataChars?: number;
      identityLabels?: number;
    } = {},
  ): Promise<SemanticSnapshot> {
    await this.clear();
    if (this.closed) throw new Error("Snapshot owner is closed");
    const generation = this.generation;
    for (const value of [
      options.maxNodes,
      options.maxRecords,
      options.maxChars,
      options.maxFrames,
      options.maxScopeNodes,
      options.identityNameChars,
      options.identityTextChars,
      options.identityNodes,
      options.identityAncestors,
      options.identityFrameDepth,
      options.identityMetadataChars,
      options.identityLabels,
    ])
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
        throw new Error("Snapshot limits must be positive safe integers.");
    if (options.maxChars !== undefined && options.maxChars < 512)
      throw new Error("Snapshot output budget must be at least 512 bytes.");
    const identity: IdentityBudget = {
      nameChars: options.identityNameChars ?? 240,
      textChars: options.identityTextChars ?? 500,
      nodes: options.identityNodes ?? 200,
      ancestors: options.identityAncestors ?? 128,
      frameDepth: options.identityFrameDepth ?? 32,
      metadataChars: options.identityMetadataChars ?? 1024,
      labels: options.identityLabels ?? 16,
    };
    const nodes = Math.max(1, Math.floor(options.maxNodes ?? 2000));
    const maxRecords = Math.max(1, Math.floor(options.maxRecords ?? 100));
    const chars = Math.max(512, Math.floor(options.maxChars ?? 12000));
    const title = await this.page.evaluate(() => ({
      value: document.title.slice(0, 500),
      truncated: document.title.length > 500,
    }));
    const titleBound = boundedText(
      title.value,
      Math.max(32, Math.floor(chars / 8)),
    );
    const urlBound = boundedText(
      safeUrl(this.page.url()),
      Math.max(32, Math.floor(chars / 8)),
    );
    const result: SemanticSnapshot = {
      title: titleBound.text,
      url: urlBound.text,
      records: [],
      omitted: [
        "Closed shadow roots and unloaded content are not inspected.",
        "Names and roles are approximate; use DOM or screenshot for detail.",
      ],
    };
    if (title.truncated || titleBound.truncated || urlBound.truncated)
      result.omitted.push("Title or URL truncated to fit metadata budget.");
    if (options.frame && !this.page.frames().includes(options.frame))
      throw new Error("Frame does not belong to this page.");
    const frames = options.frame
      ? [options.frame]
      : options.selector
        ? [this.page.mainFrame()]
        : this.page.frames();
    if (options.selector && !options.frame && this.page.frames().length > 1)
      result.omitted.push(
        "Scoped capture excludes child frames; inspect a frame explicitly.",
      );
    try {
      const maxFrames = options.maxFrames ?? 32;
      for (const frame of frames.slice(0, maxFrames)) {
        if (result.records.length >= maxRecords) {
          result.omitted.push(
            "Record limit reached; inspect a narrower scope.",
          );
          break;
        }
        if (frame !== this.page.mainFrame()) {
          try {
            const state = await visibleFrameChain(frame, identity);
            if (state !== "visible") {
              result.omitted.push(
                state === "hidden"
                  ? "1 hidden frame omitted."
                  : state === "frame_limit"
                    ? "1 frame omitted: frame ancestry budget exceeded."
                    : "1 frame omitted: visibility ancestor budget exceeded.",
              );
              continue;
            }
          } catch (error) {
            if (options.frame) throw error;
            result.omitted.push("1 inaccessible frame omitted.");
            continue;
          }
        }
        let root;
        try {
          root = await frame.evaluateHandle(collect, {
            selector: options.selector,
            nodes,
            records: maxRecords - result.records.length,
            chars,
            scopeNodes: options.maxScopeNodes ?? 20000,
            identity,
          });
        } catch (error) {
          if (options.frame || frame === this.page.mainFrame()) throw error;
          result.omitted.push("Frame unavailable during capture.");
          continue;
        }
        try {
          const props = await root.getProperties();
          const recordsHandle = props.get("records")!;
          const truncated = await props.get("truncated")!.jsonValue();
          const pending = await props.get("pending")!.jsonValue();
          const clipped = await props.get("clipped")!.jsonValue();
          const oversized = await props.get("oversized")!.jsonValue();
          const incompleteNames = await props
            .get("incompleteNames")!
            .jsonValue();
          const idScope = await props.get("idScope")!.jsonValue();
          const visual = await props.get("visual")!.jsonValue();
          const safe = await props.get("safeValues")!.jsonValue();
          if (truncated)
            result.omitted.push(
              `Traversal limit reached; ${pending} queued nodes omitted (additional descendants unknown). Inspect a narrower scope.`,
            );
          if (oversized)
            result.omitted.push(
              `${oversized} subtrees omitted because metadata or label count exceeds limits; use DOM inspection.`,
            );
          if (incompleteNames)
            result.omitted.push(
              `${incompleteNames} semantic names were incomplete or visibility ancestry could not be fully verified; their records have no actionable reference.`,
            );
          if (idScope)
            result.omitted.push(
              "Exact ID scope uses the first match; duplicate IDs are not checked.",
            );
          if (clipped)
            result.omitted.push(
              `${clipped} text, name or value fields clipped to their display or identity limits.`,
            );
          if (visual)
            result.omitted.push(
              "Canvas or SVG may require screenshot or DOM inspection.",
            );
          if (!safe)
            result.omitted.push(
              "Form values omitted because safe type detection could not be established.",
            );
          const frameLabel =
            frame === this.page.mainFrame()
              ? { text: "main", truncated: false }
              : boundedText(
                  safeUrl(frame.url()),
                  Math.max(32, Math.floor(chars / 10)),
                );
          if (
            frameLabel.truncated &&
            !result.omitted.includes(
              "Frame URL truncated to fit metadata budget.",
            )
          )
            result.omitted.push("Frame URL truncated to fit metadata budget.");
          const items = await recordsHandle.getProperties();
          for (const [key, item] of items) {
            if (!/^\d+$/.test(key)) continue;
            const fields = await item.getProperties();
            const nodeField = fields.get("node");
            const node = nodeField?.asElement();
            if (nodeField && !node)
              throw new Error("Could not retain snapshot element");
            const data: any = {};
            for (const [name, value] of fields)
              if (name !== "node") data[name] = await value.jsonValue();
            let ref: string | undefined;
            if (node) {
              ref = randomUUID();
              this.entries.set(ref, {
                handle: node,
                frame,
                fingerprint: data.fingerprint,
                identity,
              });
            }
            delete data.fingerprint;
            result.records.push({
              ...(ref ? { ref } : {}),
              frame: frameLabel.text,
              ...data,
            });
            for (const [name, value] of fields)
              if (name !== "node") await value.dispose();
            await item.dispose();
          }
          await Promise.all([...props.values()].map((p) => p.dispose()));
        } finally {
          await root.dispose();
        }
      }
      if (frames.length > maxFrames)
        result.omitted.push(
          `Frame limit reached; ${frames.length - maxFrames} frames omitted.`,
        );
      // Preserve the two coverage caveats and summarize excessive frame/gap notices.
      const idNotice =
        "Exact ID scope uses the first match; duplicate IDs are not checked.";
      const idIndex = result.omitted.indexOf(idNotice);
      if (idIndex > 2) {
        result.omitted.splice(idIndex, 1);
        result.omitted.splice(2, 0, idNotice);
      }
      const protectedCount = idIndex >= 0 ? 3 : 2;
      const noticeBytes = () =>
        Buffer.byteLength(JSON.stringify({ ...result, records: [] }), "utf8");
      let omittedNotices = 0;
      while (
        result.omitted.length > protectedCount &&
        noticeBytes() > Math.floor(chars * 0.65)
      ) {
        result.omitted.pop();
        omittedNotices++;
      }
      if (omittedNotices) {
        result.omitted.push(
          `${omittedNotices} additional omission notices suppressed to fit the budget.`,
        );
        while (
          result.omitted.length > protectedCount + 1 &&
          noticeBytes() > Math.floor(chars * 0.8)
        ) {
          result.omitted.splice(result.omitted.length - 2, 1);
          omittedNotices++;
          result.omitted[result.omitted.length - 1] =
            `${omittedNotices} additional omission notices suppressed to fit the budget.`;
        }
      }
      if (
        Buffer.byteLength(JSON.stringify(result), "utf8") > chars &&
        result.records.length
      ) {
        const all = result.records;
        let lo = 0,
          hi = all.length - 1;
        result.omitted.push("");
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          result.records = all.slice(0, mid);
          result.omitted[result.omitted.length - 1] =
            `Output limit reached; ${all.length - mid} records omitted. Inspect a narrower scope.`;
          if (Buffer.byteLength(JSON.stringify(result), "utf8") <= chars)
            lo = mid;
          else hi = mid - 1;
        }
        result.records = all.slice(0, lo);
        result.omitted[result.omitted.length - 1] =
          `Output limit reached; ${all.length - lo} records omitted. Inspect a narrower scope.`;
        for (const removed of all.slice(lo)) {
          const entry = removed.ref ? this.entries.get(removed.ref) : undefined;
          if (removed.ref) this.entries.delete(removed.ref);
          await entry?.handle.dispose();
        }
      }
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > chars)
        throw new Error("Snapshot metadata exceeds output limit.");
      if (generation !== this.generation || this.closed)
        throw new Error("Document changed during snapshot; retry.");
      return result;
    } catch (error) {
      await this.clear();
      throw error;
    }
  }
  async resolve(ref: string): Promise<ElementHandle> {
    const entry = this.entries.get(ref);
    if (!entry || this.closed || entry.frame.isDetached())
      throw new Error("Stale reference; take a new snapshot.");
    if (
      (await visibleFrameChain(entry.frame, entry.identity).catch(
        () => "hidden",
      )) !== "visible"
    )
      throw new Error("Stale reference; take a new snapshot.");
    const valid = await entry.handle
      .evaluate(
        (el, { fingerprint, identity }) => {
          if (!el.isConnected) return false;
          let depth = 0;
          for (
            let current: Element | null = el;
            current;
            current =
              current.parentElement ??
              (current.getRootNode() instanceof ShadowRoot
                ? (current.getRootNode() as ShadowRoot).host
                : null)
          ) {
            if (++depth > identity.ancestors) return false;
            const style = getComputedStyle(current);
            if (
              current.hasAttribute("hidden") ||
              current.getAttribute("aria-hidden") === "true" ||
              style.contentVisibility === "hidden" ||
              style.display === "none" ||
              style.visibility === "hidden" ||
              style.visibility === "collapse"
            )
              return false;
          }
          const tag = el.tagName.toLowerCase();
          const input = tag === "input" ? (el as HTMLInputElement) : null;
          const type = input?.type.toLowerCase() || "";
          const attr = (name: string) => {
            const value = el.getAttribute(name);
            if (value !== null && value.length > identity.metadataChars)
              throw new Error("Metadata exceeds limit");
            return value;
          };
          const role =
            attr("role") ||
            (tag === "button"
              ? "button"
              : tag === "a" && el.hasAttribute("href")
                ? "link"
                : /^h[1-6]$/.test(tag)
                  ? "heading"
                  : tag === "textarea"
                    ? "textbox"
                    : tag === "select"
                      ? "combobox"
                      : input
                        ? [
                            "checkbox",
                            "radio",
                            "button",
                            "submit",
                            "reset",
                          ].includes(type)
                          ? type === "submit" || type === "reset"
                            ? "button"
                            : type
                          : "textbox"
                        : "");
          let incompleteIdentity = false;
          const visibleText = (element: Element): string => {
            let ancestor: Element | null = element;
            let depth = 0;
            while (ancestor && depth++ < identity.ancestors) {
              const style = getComputedStyle(ancestor);
              if (
                ancestor.hasAttribute("hidden") ||
                ancestor.getAttribute("aria-hidden") === "true" ||
                style.display === "none" ||
                style.contentVisibility === "hidden" ||
                style.visibility === "hidden" ||
                style.visibility === "collapse"
              )
                return "";
              const root = ancestor.getRootNode();
              ancestor =
                ancestor.parentElement ??
                (root instanceof ShadowRoot ? root.host : null);
            }
            if (ancestor) {
              incompleteIdentity = true;
              return "";
            }
            const pending: Node[] = [element];
            let text = "",
              visited = 0;
            while (
              pending.length &&
              visited++ < identity.nodes &&
              text.length < identity.textChars
            ) {
              const node = pending.pop()!;
              if (node.nodeType === Node.TEXT_NODE) {
                const value = node.nodeValue || "";
                const part = ` ${value}`;
                const remaining = identity.textChars - text.length;
                if (part.length > remaining) incompleteIdentity = true;
                text += part.slice(0, remaining);
                continue;
              }
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              const item = node as Element;
              if (
                [
                  "SCRIPT",
                  "STYLE",
                  "NOSCRIPT",
                  "TEMPLATE",
                  "INPUT",
                  "TEXTAREA",
                  "SELECT",
                ].includes(item.tagName)
              )
                continue;
              const style = getComputedStyle(item);
              if (
                item.hasAttribute("hidden") ||
                item.getAttribute("aria-hidden") === "true" ||
                style.contentVisibility === "hidden" ||
                style.display === "none" ||
                style.visibility === "hidden" ||
                style.visibility === "collapse"
              )
                continue;
              for (
                let child = item.lastChild;
                child;
                child = child.previousSibling
              ) {
                if (pending.length >= identity.nodes) {
                  incompleteIdentity = true;
                  break;
                }
                pending.push(child);
              }
            }
            if (pending.length) incompleteIdentity = true;
            return text;
          };
          const labelled = attr("aria-labelledby");
          const ids = labelled ? labelled.trim().split(/\s+/) : [];
          if (
            ids.length > identity.labels ||
            (input?.labels?.length ?? 0) > identity.labels
          )
            return false;
          const root = el.getRootNode();
          const labelText = ids
            .map((id) => {
              const label =
                root instanceof Document || root instanceof ShadowRoot
                  ? root.getElementById(id)
                  : null;
              return label ? visibleText(label) : "";
            })
            .join(" ");
          const labels = input?.labels
            ? Array.from(input.labels)
                .map((l) => visibleText(l))
                .join(" ")
            : "";
          const rawName = (
            attr("aria-label") ||
            labelText ||
            labels ||
            attr("alt") ||
            attr("title") ||
            (input && ["submit", "button", "reset"].includes(type)
              ? (() => {
                  const value = input.value;
                  if (value.length > identity.metadataChars)
                    incompleteIdentity = true;
                  return value.slice(0, identity.metadataChars);
                })()
              : "") ||
            visibleText(el) ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();
          if (incompleteIdentity || rawName.length > identity.nameChars)
            return false;
          return (
            JSON.stringify([tag, type, role, rawName, attr("href")]) ===
            fingerprint
          );
        },
        { fingerprint: entry.fingerprint, identity: entry.identity },
      )
      .catch(() => false);
    if (!valid || this.entries.get(ref) !== entry)
      throw new Error("Stale reference; take a new snapshot.");
    return entry.handle;
  }
}
