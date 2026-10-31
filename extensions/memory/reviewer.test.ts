import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import {
  MemoryReviewer as RealReviewer,
  expandFileCitation,
} from "./reviewer.ts";
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
        : instruction.includes("Independently review duplicate")
          ? {
              action: "no_change",
              reason: "No duplicates.",
              evidenceSufficient: true,
            }
          : instruction.startsWith("Independently classify")
            ? {
                authority: "fact",
                noInstructionOrPreference: true,
                reason: "Descriptive fact.",
              }
            : instruction.startsWith("Independently")
              ? {
                  verdict: "supported",
                  reason: "Full source supports the proposal.",
                }
              : decide(data),
  };
}

test("file quote expansion requires a unique match and complete enclosing paragraphs", () => {
  assert.equal(
    expandFileCitation(
      'before\n  description: "picker",\nafter\n\nother',
      '"picker"',
    ),
    'before\n  description: "picker",\nafter',
  );
  assert.equal(
    expandFileCitation("\n  alpha beta\n\nnext", "\n  alpha"),
    "\n  alpha beta",
  );
  assert.equal(
    expandFileCitation("first\n\nalpha beta  \n", "beta  \n"),
    "alpha beta  \n",
  );
  assert.equal(expandFileCitation("same\n\nsame", "same"), undefined);
  assert.equal(expandFileCitation("one", "missing"), undefined);
});

test("a unique code substring supports a factual correction after full paragraph assessment", () =>
  fixture(async (cwd, store) => {
    await writeFile(
      join(cwd, "code.txt"),
      'register({\n  description: "picker supports frames",\n});\n',
    );
    const old = (
      await store.remember("knowledge", "Picker lacks frame support.")
    ).memory;
    const base = model(
      (d) => ({
        action: "update",
        id: old.id,
        content: "Picker supports frames.",
        targetAuthority: "fact",
        reason: "Current code.",
        citation: {
          kind: "file",
          id: d.files[0].id,
          quote: '"picker supports frames"',
        },
      }),
      ["code.txt"],
    );
    let assessed = false;
    const reviewer = new Reviewer({
      project: cwd,
      store,
      model: {
        generate: async (input) => {
          if (
            input.instruction.startsWith("Independently assess the proposal")
          ) {
            assert.equal(
              (input.data as any).proposal.citation.quote,
              'register({\n  description: "picker supports frames",\n});',
            );
            assessed = true;
          }
          return base.generate(input);
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(result.status, "applied");
    assert.equal(assessed, true);
    assert.equal(
      (await store.list()).memories[0].content,
      "Picker supports frames.",
    );
  }));

test("an excerpt substring is expanded and its complete file crosschecked", () =>
  fixture(async (cwd, store) => {
    const paragraph =
      'register({\n  description: "picker supports frames",\n});';
    const full = `Other context.\n\n${paragraph}\n`;
    await writeFile(join(cwd, "code.txt"), full);
    const old = (
      await store.remember("knowledge", "Picker lacks frame support.")
    ).memory;
    let crosschecked = false;
    const reviewer = new Reviewer({
      project: cwd,
      store,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select"))
            return {
              excerpts: [{ path: "code.txt", query: "picker supports frames" }],
            };
          if (instruction.includes("Independently review duplicate"))
            return {
              action: "no_change",
              reason: "No duplicates.",
              evidenceSufficient: true,
            };
          if (instruction.startsWith("Independently classify"))
            return {
              authority: "fact",
              noInstructionOrPreference: true,
              reason: "Fact.",
            };
          if (instruction.startsWith("Independently compare")) {
            assert.equal(data.evidence.text, full);
            assert.equal(data.proposal.citation.quote, paragraph);
            crosschecked = true;
            return { verdict: "no_conflict", reason: "No conflict." };
          }
          if (instruction.startsWith("Independently assess"))
            return {
              verdict: "supported",
              reason: "Source supports correction.",
            };
          return {
            action: "update",
            id: old.id,
            content: "Picker supports frames.",
            targetAuthority: "fact",
            reason: "Current code.",
            citation: {
              kind: "file",
              id: data.files[0].id,
              quote: '"picker supports frames"',
            },
          };
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(result.status, "applied");
    assert.equal(crosschecked, true);
  }));

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
    const invalid = await a.review({ batch: b.batch });
    assert.equal(invalid.status, "unresolved");
    assert.match(invalid.detail, /direct user message/);
    assert.equal(b.count(), 0);
  }));

test("full context prevents substring negation and stale evidence fails before mutation", () =>
  fixture(async (cwd, store) => {
    await writeFile(join(cwd, "fact.txt"), "Cache enabled is false.\n");
    const b = batch([{ id: "u", role: "user", text: "Review cache." }]);
    const base = model(
      (d) => ({
        action: "add",
        category: "knowledge",
        content: "Cache is enabled.",
        citation: { kind: "file", id: d.files[0].id, quote: "Cache enabled" },
        reason: "A substring claims cache enabled.",
      }),
      ["fact.txt"],
    );
    const bad = new Reviewer({
      project: cwd,
      store,
      model: {
        generate: async (input) => {
          if (
            input.instruction.startsWith("Independently assess the proposal")
          ) {
            assert.equal(
              (input.data as any).proposal.citation.quote,
              "Cache enabled is false.",
            );
            return {
              verdict: "unsupported",
              reason: "The full paragraph negates the claim.",
            };
          }
          return base.generate(input);
        },
      },
    });
    const invalid = await bad.review({ batch: b.batch });
    assert.equal(invalid.status, "unresolved");
    assert.match(invalid.detail, /Independent evidence assessment/);
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
    assert.equal(
      (await forged.review({ batch: b.batch })).status,
      "unresolved",
    );
    const uncertain = new Reviewer({
      project: cwd,
      store,
      model: {
        generate: async ({ instruction }: any) =>
          instruction.startsWith("Select")
            ? { paths: [] }
            : instruction.includes("Independently review duplicate")
              ? {
                  action: "no_change",
                  reason: "No duplicates.",
                  evidenceSufficient: true,
                }
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

test("manual full review leaves insufficient no-change unresolved", () =>
  fixture(async (cwd, store) => {
    await store.remember("knowledge", "Node is installed.");
    const r = new Reviewer({
      project: cwd,
      store,
      model: model((d) => {
        assert.equal(d.mode, "full");
        return {
          action: "no_change",
          reason: "Insufficient evidence.",
          evidenceSufficient: false,
        };
      }),
    });
    const result = await r.review();
    assert.equal(result.status, "unresolved");
    assert.equal(result.acknowledged, false);
    assert.match(result.detail, /insufficient/i);
    assert.equal(result.audit?.coverage, "insufficient");
  }));
