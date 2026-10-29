export type BodyDirection = "request" | "response";
export type BodyState =
  | "disabled"
  | "pending"
  | "captured"
  | "oversized"
  | "unsupported"
  | "evicted"
  | "failed"
  | "absent";
type Item = {
  state: BodyState;
  bytes?: Buffer;
  reason?: string;
  controllers?: Set<AbortController>;
  tab: string;
  request: string;
};
type Session = { enabled: boolean; items: Map<string, Item>; retained: number };

/** Optional shared artifact transport. The sink must copy or consume bytes before resolving,
 * enforce owner isolation and private binary storage, and honor cancellation. */
export type BodyArtifactSink = (
  owner: string,
  bytes: Buffer,
  signal: AbortSignal,
) => Promise<unknown>;

/** Session-local retention only. Backend/Playwright buffering is outside these limits. */
export class BodyCapture {
  private sessions = new Map<string, Session>();
  private pendingExports = 0;
  readonly maxBody: number;
  readonly maxSession: number;
  private readonly sink?: BodyArtifactSink;
  private readonly onEvict?: (
    sessionId: string,
    tabId: string,
    requestId: string,
  ) => void;
  constructor(
    maxBody = 1024 * 1024,
    maxSession = 8 * 1024 * 1024,
    sink?: BodyArtifactSink,
    privateOnEvict?: (
      sessionId: string,
      tabId: string,
      requestId: string,
    ) => void,
  ) {
    this.onEvict = privateOnEvict;
    this.sink = sink;
    this.maxBody = maxBody;
    this.maxSession = maxSession;
    if (
      ![maxBody, maxSession].every((n) => Number.isSafeInteger(n) && n > 0) ||
      maxBody > maxSession
    )
      throw new Error("Invalid body limits.");
  }
  start(sessionId: string, enabled: boolean) {
    if (!this.sessions.has(sessionId))
      this.sessions.set(sessionId, { enabled, items: new Map(), retained: 0 });
  }
  private session(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("Body capture session unavailable.");
    return s;
  }
  private key(tab: string, request: string, direction: BodyDirection) {
    return JSON.stringify([tab, request, direction]);
  }
  configure(id: string, enabled: boolean) {
    this.session(id).enabled = enabled;
  }
  enabled(id: string) {
    return this.session(id).enabled;
  }
  begin(id: string, tab: string, request: string) {
    const s = this.session(id);
    for (const direction of ["request", "response"] as const)
      s.items.set(this.key(tab, request, direction), {
        state: s.enabled ? "pending" : "disabled",
        tab,
        request,
      });
  }
  set(
    id: string,
    tab: string,
    request: string,
    direction: BodyDirection,
    state: BodyState,
    bytes?: Buffer,
    reason?: string,
  ) {
    const s = this.session(id),
      key = this.key(tab, request, direction),
      item = s.items.get(key);
    if (!item) return;
    for (const controller of item.controllers ?? []) controller.abort();
    if (item.bytes) s.retained -= item.bytes.length;
    delete item.bytes;
    if (state === "captured" && bytes) {
      if (bytes.length > this.maxBody || bytes.length > this.maxSession)
        state = "oversized";
      else {
        while (s.retained + bytes.length > this.maxSession) {
          const oldest = [...s.items.values()].find((x) => x.bytes);
          if (!oldest?.bytes) break;
          s.retained -= oldest.bytes.length;
          for (const controller of oldest.controllers ?? []) controller.abort();
          delete oldest.bytes;
          oldest.state = "evicted";
          oldest.reason = "Body evicted by session retention budget.";
          this.onEvict?.(id, oldest.tab, oldest.request);
        }
        // Eviction notification may synchronously trim the new request's history.
        if (s.items.get(key) !== item) return;
        item.bytes = Buffer.from(bytes);
        s.retained += bytes.length;
      }
    }
    item.state = state;
    item.reason =
      state === "oversized" && !reason
        ? "Body exceeds retention limit."
        : reason;
  }
  reason(id: string, tab: string, request: string, direction: BodyDirection) {
    return this.session(id).items.get(this.key(tab, request, direction))
      ?.reason;
  }
  state(id: string, tab: string, request: string, direction: BodyDirection) {
    return this.session(id).items.get(this.key(tab, request, direction))?.state;
  }
  drop(id: string, tab: string, request: string) {
    const s = this.session(id);
    for (const direction of ["request", "response"] as const) {
      const key = this.key(tab, request, direction),
        item = s.items.get(key);
      if (item?.bytes) s.retained -= item.bytes.length;
      for (const controller of item?.controllers ?? []) controller.abort();
      s.items.delete(key);
    }
  }
  end(id: string) {
    const s = this.sessions.get(id);
    if (s)
      for (const item of s.items.values())
        for (const controller of item.controllers ?? []) controller.abort();
    this.sessions.delete(id);
  }
  shutdown() {
    for (const id of this.sessions.keys()) this.end(id);
  }
  async export(
    id: string,
    tab: string,
    request: string,
    direction: BodyDirection,
    owner: string,
    signal?: AbortSignal,
  ) {
    if (!this.sink) throw new Error("Binary artifact transport unavailable.");
    const item = this.session(id).items.get(this.key(tab, request, direction));
    if (!item?.bytes) throw new Error("Body unavailable or evicted.");
    if (signal?.aborted) throw new Error("Body export cancelled.");
    if (this.pendingExports >= 2)
      throw new Error("Body export capacity exhausted.");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    (item.controllers ??= new Set()).add(controller);
    this.pendingExports++;
    try {
      return await this.sink(owner, item.bytes, controller.signal);
    } finally {
      this.pendingExports--;
      item.controllers.delete(controller);
      signal?.removeEventListener("abort", cancel);
    }
  }
  inspect(
    id: string,
    tab: string,
    request: string,
    direction: BodyDirection,
    offset = 0,
    maxBytes = 8192,
  ) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 8192
    )
      throw new Error("Invalid body chunk.");
    const item = this.session(id).items.get(this.key(tab, request, direction));
    if (!item) throw new Error("Request unavailable or evicted.");
    if (!item.bytes)
      return {
        state: item.state,
        notice: item.reason ?? "Body unavailable; no request was replayed.",
      };
    if (offset > item.bytes.length)
      throw new Error("Body offset exceeds length.");
    const chunk = item.bytes.subarray(offset, offset + maxBytes),
      next = offset + chunk.length;
    return {
      state: item.state,
      encoding: "base64",
      bytes: item.bytes.length,
      offset,
      chunkBytes: chunk.length,
      data: chunk.toString("base64"),
      nextOffset: next < item.bytes.length ? next : null,
    };
  }
}
