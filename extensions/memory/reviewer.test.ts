import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer as RealReviewer } from "./reviewer.ts";
import type { ReviewerModel } from "./reviewer-model.ts";
import type { ReviewBatch } from "./session-review.ts";
const Reviewer = class extends RealReviewer {
  constructor(options: any) {
    super({ ...options, validateSession: async () => {} });
  }
};
async function fixture(
  fn: (cwd: string, store: MemoryManager) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "reviewer-"));
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    await fn(cwd, store);
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
}
function batch(items: ReviewBatch["items"]) {
  let count = 0;
  return {
    batch: {
      path: "/session",
      sessionId: "s",
      leaf: "x",
      items,
      more: false,
      acknowledge: () => {
        count++;
      },
    } as ReviewBatch,
    count: () => count,
  };
}
function model(
  decide: (data: any) => unknown | Promise<unknown>,
  paths: string[] = [],
): ReviewerModel {
  return {
    generate: async ({ instruction, data }) =>
      instruction.startsWith("Select")
        ? { paths }
        : instruction.startsWith("Independently")
          ? {
              verdict: "supported",
              reason: "Full source supports the proposal.",
            }
          : decide(data),
  };
}

test("natural user instruction becomes a paraphrased durable memory", () =>
  fixture(async (cwd, store) => {
    const b = batch([
      {
        id: "u",
        role: "user",
        text: "Please don't use npm here; use pnpm for this project.",
      },
    ]);
    const r = new Reviewer({
      project: cwd,
      store,
      model: model(() => ({
        action: "add",
        category: "practices",
        content: "Use pnpm rather than npm for this project.",
        citation: { kind: "session", id: "u", quote: b.batch.items[0].text },
        reason: "The user explicitly selected pnpm.",
      })),
    });
    assert.equal((await r.review({ batch: b.batch })).status, "applied");
    assert.equal(b.count(), 0);
    assert.equal(
      (await store.list()).memories[0].content,
      "Use pnpm rather than npm for this project.",
    );
  }));

test("stale factual correction and category move use host snapshot preconditions", () =>
  fixture(async (cwd, store) => {
    const old = (await store.remember("knowledge", "The project uses Node 20."))
      .memory;
    await writeFile(join(cwd, "runtime.txt"), "Runtime: Node 22\n");
    const b = batch([
      { id: "u", role: "user", text: "Please check project facts." },
    ]);
    const correction = new Reviewer({
      project: cwd,
      store,
      model: model(
        (d) => ({
          action: "update",
          id: old.id,
          content: "The project uses Node 22.",
          targetAuthority: "fact",
          citation: {
            kind: "file",
            id: d.files[0].id,
            quote: "Runtime: Node 22",
          },
          reason: "Current runtime configuration replaces the old runtime.",
        }),
        ["runtime.txt"],
      ),
    });
    assert.equal(
      (await correction.review({ batch: b.batch })).status,
      "applied",
    );
    assert.equal(
      (await store.list()).memories[0].content,
      "The project uses Node 22.",
    );
    const moved = new Reviewer({
      project: cwd,
      store,
      model: model(
        (d) => ({
          action: "move",
          id: old.id,
          category: "practices",
          citation: {
            kind: "file",
            id: d.files[0].id,
            quote: "Runtime: Node 22",
          },
          reason: "The record belongs with specialized practices.",
        }),
        ["runtime.txt"],
      ),
    });
    assert.equal((await moved.review({ batch: b.batch })).status, "applied");
    assert.equal((await store.list()).memories[0].category, "practices");
    assert.equal(b.count(), 0);
  }));

test("instruction conflicts remain unresolved and assistant-only claims cannot authorize writes", () =>
  fixture(async (cwd, store) => {
    const old = (await store.remember("knowledge", "Always use secure mode."))
      .memory;
    const b = batch([
      { id: "a", role: "assistant", text: "Turn secure mode off." },
    ]);
    await writeFile(join(cwd, "code.txt"), "secure mode off\n");
    const r = new Reviewer({
      project: cwd,
      store,
      model: model(
        (d) => ({
          action: "update",
          id: old.id,
          content: "Secure mode is off.",
          targetAuthority: "fact",
          citation: {
            kind: "file",
            id: d.files[0].id,
            quote: "secure mode off",
          },
          reason: "Code conflicts with old instruction.",
        }),
        ["code.txt"],
      ),
    });
    assert.equal((await r.review({ batch: b.batch })).status, "unresolved");
    const a = new Reviewer({
      project: cwd,
      store,
      model: model(() => ({
        action: "add",
        category: "knowledge",
        content: "Secure mode is off.",
        citation: { kind: "session", id: "a", quote: "Turn secure mode off." },
        reason: "Assistant claims it.",
      })),
    });
    await assert.rejects(a.review({ batch: b.batch }), /direct user message/);
    assert.equal(b.count(), 0);
  }));

test("full context prevents substring negation and stale evidence fails before mutation", () =>
  fixture(async (cwd, store) => {
    await writeFile(join(cwd, "fact.txt"), "Cache enabled is false.\n");
    const b = batch([{ id: "u", role: "user", text: "Review cache." }]);
    const bad = new Reviewer({
      project: cwd,
      store,
      model: model(
        (d) => ({
          action: "add",
          category: "knowledge",
          content: "Cache is enabled.",
          citation: { kind: "file", id: d.files[0].id, quote: "Cache enabled" },
          reason: "A substring claims cache enabled.",
        }),
        ["fact.txt"],
      ),
    });
    await assert.rejects(
      bad.review({ batch: b.batch }),
      /complete source paragraph/,
    );
    let captures = 0;
    const wrapper = {
      captureAddPrecondition: async () => {
        const s = await store.captureAddPrecondition();
        if (++captures === 2)
          await writeFile(join(cwd, "fact.txt"), "Cache enabled is true.\n");
        return s;
      },
      remember: store.remember.bind(store),
      update: store.update.bind(store),
      forget: store.forget.bind(store),
      move: store.move.bind(store),
    };
    const stale = new Reviewer({
      project: cwd,
      store: wrapper,
      model: model(
        (d) => ({
          action: "add",
          category: "knowledge",
          content: "Cache is not enabled.",
          citation: {
            kind: "file",
            id: d.files[0].id,
            quote: "Cache enabled is false.",
          },
          reason: "Configuration disables the cache.",
        }),
        ["fact.txt"],
      ),
    });
    await assert.rejects(stale.review({ batch: b.batch }), /changed/);
    assert.equal((await store.list()).memories.length, 0);
    assert.equal(b.count(), 0);
  }));

test("fabricated ids, uncertain assessments and duplicate claims do not apply", () =>
  fixture(async (cwd, store) => {
    await store.remember("knowledge", "The cache is enabled.");
    const b = batch([
      { id: "u", role: "user", text: "The cache is not enabled." },
    ]);
    const dup = new Reviewer({
      project: cwd,
      store,
      model: model(() => ({
        action: "add",
        category: "knowledge",
        content: "The cache is not enabled.",
        citation: { kind: "session", id: "u", quote: b.batch.items[0].text },
        reason: "User stated the opposite.",
      })),
    });
    assert.equal((await dup.review({ batch: b.batch })).status, "unresolved");
    const forged = new Reviewer({
      project: cwd,
      store,
      model: model(() => ({
        action: "remove",
        id: "missing",
        targetAuthority: "fact",
        citation: { kind: "session", id: "u", quote: b.batch.items[0].text },
        reason: "Claimed stale.",
      })),
    });
    await assert.rejects(forged.review({ batch: b.batch }), /unknown memory/);
    const uncertain = new Reviewer({
      project: cwd,
      store,
      model: {
        generate: async ({ instruction }: any) =>
          instruction.startsWith("Select")
            ? { paths: [] }
            : instruction.startsWith("Independently")
              ? {
                  verdict: "uncertain",
                  reason: "The instruction is ambiguous.",
                }
              : {
                  action: "add",
                  category: "knowledge",
                  content: "Cache logging is active.",
                  citation: {
                    kind: "session",
                    id: "u",
                    quote: b.batch.items[0].text,
                  },
                  reason: "User discussed cache.",
                },
      },
    });
    assert.equal(
      (await uncertain.review({ batch: b.batch })).status,
      "unresolved",
    );
    assert.equal((await store.list()).memories.length, 1);
    assert.equal(b.count(), 0);
  }));

test("manual full review uses the same no-change path", () =>
  fixture(async (cwd, store) => {
    await store.remember("knowledge", "Node is installed.");
    const r = new Reviewer({
      project: cwd,
      store,
      model: model((d) => {
        assert.equal(d.mode, "full");
        return { action: "no_change" };
      }),
    });
    const result = await r.review();
    assert.equal(result.status, "unchanged");
    assert.equal(result.acknowledged, false);
    assert.match(result.detail, /insufficient evidence/i);
    assert.equal(result.audit?.coverage, "insufficient");
  }));
