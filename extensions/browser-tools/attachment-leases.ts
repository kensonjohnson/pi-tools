import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { acquireProfile, type ProfileLease } from "./profiles.ts";
import { validateAttachmentEndpoint } from "./attachment-endpoint.ts";

type Selection = {
  key: string;
  page: Page;
  lock: ProfileLease;
  onClose: () => void;
  active: boolean;
  releasing: boolean;
  quarantined: boolean;
};
type Options = { signal?: AbortSignal; timeoutMs?: number };

/**
 * Target IDs are globally keyed, rather than endpoint-keyed. A collision between
 * browsers over-serializes but cannot enable sharing. The lock root must be
 * shared by all cooperating processes and not modified by an adversarial user.
 * Crash/uncertain cleanup leaves the durable profile marker for manual recovery.
 */
export class AttachmentLeases {
  private closed = false;
  private cleanupErrors = 0;
  private readonly stop = new AbortController();
  private sequence = new Map<string, number>();
  private selected = new Map<string, Selection>();
  private readonly connection: { browser: Browser; disconnect(): void };
  private readonly root: string;
  constructor(
    connection: { browser: Browser; disconnect(): void },
    origin: string,
    options: { lockRoot?: string } = {},
  ) {
    this.connection = connection;
    const url = validateAttachmentEndpoint(origin, "http:");
    if (url.pathname !== "/" || url.search)
      throw new Error("Attachment origin required");
    this.root =
      options.lockRoot ??
      join(homedir(), ".pi", "agent", "browser-attachment-leases");
    connection.browser.once("disconnected", () => {
      void this.disconnect();
    });
  }
  private check(owner: string, signal?: AbortSignal, sequence?: number) {
    if (
      !owner ||
      this.closed ||
      signal?.aborted ||
      (sequence !== undefined && this.sequence.get(owner) !== sequence)
    )
      throw new Error(
        "Attachment unavailable, cancelled, or selection superseded",
      );
  }
  private async bounded<T>(
    owner: string,
    options: Options,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeout = options.timeoutMs ?? 5000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000)
      throw new Error("Invalid attachment timeout");
    this.check(owner, options.signal);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeout);
    const signal = AbortSignal.any([
      this.stop.signal,
      deadline.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        void this.disconnect();
        reject(
          new Error(
            "Attachment cancelled or timed out; operation outcome may be uncertain",
          ),
        );
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
    try {
      return await Promise.race([work(signal), cancelled]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
  }
  private async scan(
    owner: string,
    signal: AbortSignal,
    sequence?: number,
  ): Promise<Array<{ id: string; page: Page }>> {
    const result: Array<{ id: string; page: Page }> = [];
    for (const context of this.connection.browser.contexts())
      for (const page of context.pages()) {
        this.check(owner, signal, sequence);
        if (page.isClosed()) continue;
        const session = await context.newCDPSession(page);
        try {
          this.check(owner, signal, sequence);
          const info = await session.send("Target.getTargetInfo");
          this.check(owner, signal, sequence);
          if (!page.isClosed() && info.targetInfo.type === "page")
            result.push({ id: info.targetInfo.targetId, page });
        } finally {
          void session.detach().catch(() => {});
        }
      }
    this.check(owner, signal, sequence);
    return result;
  }
  async targets(owner: string, options: Options = {}): Promise<string[]> {
    return this.bounded(owner, options, async (signal) =>
      (await this.scan(owner, signal)).map((item) => item.id),
    );
  }
  async select(
    owner: string,
    id: string,
    options: Options = {},
  ): Promise<void> {
    if (!id || id.length > 256) throw new Error("Invalid attachment target");
    const seq = (this.sequence.get(owner) ?? 0) + 1;
    this.sequence.set(owner, seq);
    await this.bounded(owner, options, async (signal) => {
      const item = (await this.scan(owner, signal, seq)).find(
        (item) => item.id === id,
      );
      if (!item || item.page.isClosed())
        throw new Error("Attachment target unavailable; select again");
      const old = this.selected.get(owner);
      if (old?.active) throw new Error("Attachment target has active work");
      if (old?.key === id && old.page === item.page) return;
      const name = `attachment-${createHash("sha256").update(id).digest("hex").slice(0, 48)}`;
      // Acquire with the same absolute cancellation as the scan; the lock's durable
      // marker is deliberately never removed automatically after a crash.
      const lock = await acquireProfile(name, {
        root: this.root,
        signal,
        timeoutMs: options.timeoutMs ?? 5000,
      }).catch((error) => {
        if (/Profile ownership is unresolved/.test(String(error)))
          throw new Error(
            `Attachment ownership is unresolved in ${this.root}; verify no agent operation can still run before manual marker recovery. Do not close the external browser as a recovery step.`,
          );
        throw error;
      });
      try {
        this.check(owner, signal, seq);
        if (item.page.isClosed())
          throw new Error("Attachment target unavailable; select again");
        const current = this.selected.get(owner);
        if (current?.active)
          throw new Error("Attachment target has active work");
        if (current) await this.releaseOwner(owner, current);
        this.check(owner, signal, seq);
        const onClose = () => {
          void this.releaseOwner(owner, selection);
        };
        const selection: Selection = {
          key: id,
          page: item.page,
          lock,
          onClose,
          active: false,
          releasing: false,
          quarantined: false,
        };
        this.selected.set(owner, selection);
        item.page.once("close", onClose);
      } catch (error) {
        await lock.release();
        throw error;
      }
    });
  }
  /** Trusted callbacks must not retain Page or start detached work. */
  async withPage<T>(
    owner: string,
    work: (page: Page) => Promise<T>,
    options: Options = {},
  ): Promise<T> {
    this.check(owner, options.signal);
    const selection = this.selected.get(owner);
    if (!selection || selection.page.isClosed() || selection.releasing)
      throw new Error("Attachment target unavailable; select again");
    if (selection.active) throw new Error("Attachment target has active work");
    return this.bounded(owner, options, async (signal) => {
      selection.active = true;
      // Retain the lease after a caller timeout until work actually settles.
      return Promise.resolve()
        .then(() => {
          this.check(owner, signal);
          return work(selection.page);
        })
        .catch((error) => {
          selection.quarantined = true;
          void this.disconnect();
          throw new Error(
            `Attachment operation failed; outcome uncertain and ownership quarantined: ${String(error)}`,
          );
        })
        .finally(() => {
          selection.active = false;
          if (this.closed || selection.page.isClosed())
            void this.releaseOwner(owner, selection);
        });
    });
  }
  private async releaseOwner(
    owner: string,
    selection: Selection,
  ): Promise<void> {
    if (
      selection.active ||
      selection.releasing ||
      this.selected.get(owner) !== selection
    )
      return;
    selection.releasing = true;
    selection.page.off("close", selection.onClose);
    try {
      if (selection.quarantined) {
        this.cleanupErrors++;
        selection.lock.abandon();
      } else await selection.lock.release();
    } catch {
      this.cleanupErrors++;
      selection.lock.abandon();
    } finally {
      if (this.selected.get(owner) === selection) this.selected.delete(owner);
    }
  }
  async disconnect(): Promise<{ pending: number; uncertain: number }> {
    if (!this.closed) {
      this.closed = true;
      for (const selection of this.selected.values())
        if (selection.active) selection.quarantined = true;
      this.stop.abort();
      this.connection.disconnect();
    }
    const values = [...this.selected.entries()];
    await Promise.all(
      values.map(([owner, selection]) => this.releaseOwner(owner, selection)),
    );
    return {
      pending: [...this.selected.values()].filter((item) => item.active).length,
      uncertain: this.cleanupErrors,
    };
  }
}
