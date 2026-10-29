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
type Entry = { handle: ElementHandle; frame: Frame; fingerprint: string };

function frameVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  let current: Element | null = el;
  let depth = 0;
  while (current && depth++ < 128) {
    const style = getComputedStyle(current);
    if (
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.contentVisibility === "hidden" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return false;
    const root = current.getRootNode();
    current =
      current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return current === null;
}
async function visibleFrameChain(frame: Frame): Promise<boolean> {
  let current: Frame | null = frame;
  let depth = 0;
  while (current?.parentFrame()) {
    if (++depth > 32) return false;
    const element = await current.frameElement();
    try {
      if (
        !(await element.isVisible()) ||
        !(await element.evaluate(frameVisible))
      )
        return false;
    } finally {
      await element.dispose();
    }
    current = current.parentFrame();
  }
  return true;
}

// This runs as one renderer task: the metadata and node references describe the
// same traversal. It intentionally does not claim the full accessibility algorithm.
function collect(args: {
  selector?: string;
  nodes: number;
  records: number;
  chars: number;
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
        if (++inspected > 20000)
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
      if (++parentDepth > 128)
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
  // Read visible text without collecting form values or script text.
  const visibleText = (element: Element): string => {
    let ancestor: Element | null = element;
    let depth = 0;
    while (ancestor && depth++ < 128) {
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
    if (ancestor) return "";
    const pending: Node[] = [element];
    let text = "",
      visited = 0;
    while (pending.length && visited++ < 200 && text.length < 500) {
      const node = pending.pop()!;
      if (node.nodeType === Node.TEXT_NODE) {
        text += ` ${(node.nodeValue || "").slice(0, 501 - text.length)}`;
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
        child && pending.length < 200;
        child = child.previousSibling
      )
        pending.push(child);
    }
    return text;
  };
  const attr = (el: Element, name: string) => {
    const value = el.getAttribute(name);
    if (value !== null && value.length > 1024)
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
        (name) => (el.getAttribute(name)?.length ?? 0) > 1024,
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
      const labelled = attr(el, "aria-labelledby");
      const ids = labelled ? labelled.trim().split(/\s+/) : [];
      if (ids.length > 16 || (input?.labels?.length ?? 0) > 16) {
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
          ? String(valueGetter!.call(input)).slice(0, 1024)
          : "") ||
        visibleText(el) ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      if (rawName.length > 240) clipped++;
      const name = rawName.slice(0, 240);
      const fingerprint = JSON.stringify([
        tag,
        type,
        role,
        name,
        attr(el, "href"),
      ]);
      const record: (typeof records)[number] = {
        node: el,
        role,
        name,
        fingerprint,
      };
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
    } = {},
  ): Promise<SemanticSnapshot> {
    await this.clear();
    if (this.closed) throw new Error("Snapshot owner is closed");
    if (options.selector && options.selector.length > 1024)
      throw new Error("Scope selector exceeds limit.");
    const generation = this.generation;
    for (const value of [
      options.maxNodes,
      options.maxRecords,
      options.maxChars,
    ])
      if (value !== undefined && (!Number.isFinite(value) || value < 1))
        throw new Error("Snapshot limits must be positive finite numbers.");
    if (options.maxChars !== undefined && options.maxChars < 512)
      throw new Error("Snapshot output budget must be at least 512 bytes.");
    const nodes = Math.max(
      1,
      Math.min(5000, Math.floor(options.maxNodes ?? 2000)),
    );
    const maxRecords = Math.max(
      1,
      Math.min(300, Math.floor(options.maxRecords ?? 100)),
    );
    const chars = Math.max(
      512,
      Math.min(32000, Math.floor(options.maxChars ?? 12000)),
    );
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
      for (const frame of frames.slice(0, 32)) {
        if (result.records.length >= maxRecords) {
          result.omitted.push(
            "Record limit reached; inspect a narrower scope.",
          );
          break;
        }
        if (frame !== this.page.mainFrame()) {
          try {
            if (!(await visibleFrameChain(frame))) {
              result.omitted.push("1 hidden frame omitted.");
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
          if (idScope)
            result.omitted.push(
              "Exact ID scope uses the first match; duplicate IDs are not checked.",
            );
          if (clipped)
            result.omitted.push(
              `${clipped} text, name or value fields clipped to 240 characters.`,
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
      if (frames.length > 32)
        result.omitted.push(
          `Frame limit reached; ${frames.length - 32} frames omitted.`,
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
      let removedCount = 0;
      while (
        result.records.length &&
        Buffer.byteLength(JSON.stringify(result), "utf8") > chars
      ) {
        const removed = result.records.pop()!;
        const entry = removed.ref ? this.entries.get(removed.ref) : undefined;
        if (removed.ref) this.entries.delete(removed.ref);
        await entry?.handle.dispose();
        removedCount++;
        const notice = `Output limit reached; ${removedCount} records omitted. Inspect a narrower scope.`;
        if (removedCount === 1) result.omitted.push(notice);
        else result.omitted[result.omitted.length - 1] = notice;
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
    if (!(await visibleFrameChain(entry.frame).catch(() => false)))
      throw new Error("Stale reference; take a new snapshot.");
    const valid = await entry.handle
      .evaluate((el, fingerprint) => {
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
          if (++depth > 128) return false;
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
          if (value !== null && value.length > 1024)
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
        const visibleText = (element: Element): string => {
          let ancestor: Element | null = element;
          let depth = 0;
          while (ancestor && depth++ < 128) {
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
          if (ancestor) return "";
          const pending: Node[] = [element];
          let text = "",
            visited = 0;
          while (pending.length && visited++ < 200 && text.length < 500) {
            const node = pending.pop()!;
            if (node.nodeType === Node.TEXT_NODE) {
              text += ` ${(node.nodeValue || "").slice(0, 501 - text.length)}`;
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
              child && pending.length < 200;
              child = child.previousSibling
            )
              pending.push(child);
          }
          return text;
        };
        const labelled = attr("aria-labelledby");
        const ids = labelled ? labelled.trim().split(/\s+/) : [];
        if (ids.length > 16 || (input?.labels?.length ?? 0) > 16) return false;
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
        const name = (
          attr("aria-label") ||
          labelText ||
          labels ||
          attr("alt") ||
          attr("title") ||
          (input && ["submit", "button", "reset"].includes(type)
            ? input.value.slice(0, 1024)
            : "") ||
          visibleText(el) ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 240);
        return (
          JSON.stringify([tag, type, role, name, attr("href")]) === fingerprint
        );
      }, entry.fingerprint)
      .catch(() => false);
    if (!valid || this.entries.get(ref) !== entry)
      throw new Error("Stale reference; take a new snapshot.");
    return entry.handle;
  }
}
