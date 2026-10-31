import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer as RealReviewer } from "./reviewer.ts";
import type { ReviewBatch } from "./session-review.ts";
const Reviewer = class extends RealReviewer {
  constructor(options: any) {
    super({ ...options, validateSession: async () => {} });
  }
};

for (const scenario of [
  {
    name: "clear fact",
    content: "The project uses the old backend.",
    authority: "fact",
    clear: true,
    applied: true,
  },
  {
    name: "unknown authority",
    content: "The project uses the old backend.",
    authority: "unknown",
    clear: false,
    applied: false,
  },
  {
    name: "instruction classification",
    content: "The project uses the old backend.",
    authority: "instruction",
    clear: false,
    applied: false,
  },
  {
    name: "inconsistent classification",
    content: "The project uses the old backend.",
    authority: "fact",
    clear: true,
    applied: false,
  },
  {
    name: "explicit instruction",
    content: "Always use the old backend.",
    authority: "fact",
    clear: true,
    applied: false,
  },
] as const) {
  test(`missing target authority: ${scenario.name}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "review-unknown-authority-"));
    const store = new MemoryManager(cwd, { semanticEnabled: false });
    try {
      await store.init();
      const target = (await store.remember("knowledge", scenario.content))
        .memory;
      await writeFile(
        join(cwd, "source.txt"),
        "The project uses the new backend.\n",
      );
      let classifications = 0;
      const reviewer = new Reviewer({
        project: cwd,
        store,
        model: {
          generate: async ({ instruction, data }: any) => {
            if (instruction.startsWith("Select"))
              return { paths: ["source.txt"] };
            if (instruction.includes("Independently review duplicate"))
              return {
                action: "no_change",
                reason: "No duplicates.",
                evidenceSufficient: true,
              };
            if (instruction.startsWith("Independently classify")) {
              classifications++;
              return {
                authority: scenario.authority,
                noInstructionOrPreference: scenario.clear,
                reason:
                  scenario.name === "inconsistent classification"
                    ? "The target is a user instruction."
                    : "Classified target.",
              };
            }
            if (instruction.startsWith("Independently"))
              return { verdict: "supported", reason: "Supported by source." };
            return {
              action: "update",
              id: target.id,
              content: "The project uses the new backend.",
              reason: "Current source.",
              citation: {
                kind: "file",
                id: data.files[0].id,
                quote: "The project uses the new backend.",
              },
            };
          },
        },
      });
      const result = await reviewer.review();
      assert.equal(result.status, scenario.applied ? "applied" : "unresolved");
      assert.equal(
        (await store.list()).memories[0].content,
        scenario.applied
          ? "The project uses the new backend."
          : scenario.content,
      );
      assert.equal(
        classifications,
        scenario.name === "explicit instruction" ? 0 : 1,
      );
    } finally {
      await store.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("a fact label cannot override the user's preferred response format", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-preference-"));
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    const original = "The user's preferred response format is JSON.";
    const target = (await store.remember("knowledge", original)).memory;
    const implicit = (await store.remember("knowledge", "Responses use JSON."))
      .memory;
    let selectedId = target.id;
    let classifications = 0;
    await writeFile(join(cwd, "source.txt"), "Responses use plain text.\n");
    const reviewer = new Reviewer({
      project: cwd,
      store,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: ["source.txt"] };
          if (instruction.includes("Independently review duplicate"))
            return {
              action: "no_change",
              reason: "No duplicates.",
              evidenceSufficient: true,
            };
          if (instruction.startsWith("Independently classify")) {
            classifications++;
            return {
              authority: "instruction",
              noInstructionOrPreference: false,
              reason: "A response-format instruction.",
            };
          }
          if (instruction.startsWith("Independently"))
            return { verdict: "supported", reason: "Supported." };
          return {
            action: "update",
            id: selectedId,
            targetAuthority: "fact",
            content: "Responses use plain text.",
            reason: "Current source.",
            citation: {
              kind: "file",
              id: data.files[0].id,
              quote: "Responses use plain text.",
            },
          };
        },
      },
    });
    assert.equal((await reviewer.review()).status, "unresolved");
    assert.equal(
      (await store.list()).memories.find((m) => m.id === target.id)?.content,
      original,
    );
    selectedId = implicit.id;
    assert.equal((await reviewer.review()).status, "unresolved");
    assert.equal(classifications, 1);
    assert.equal(
      (await store.list()).memories.find((m) => m.id === implicit.id)?.content,
      implicit.content,
    );
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("later natural-language user instruction may supersede verified earlier explicit guidance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-authority-"));
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    const old = (await store.remember("practices", "Always use secure mode."))
      .memory;
    const prior = "Always use secure mode.";
    const later = "For this project, stop requiring secure mode from now on.";
    let acks = 0;
    const batch: ReviewBatch = {
      path: "/session",
      sessionId: "id",
      leaf: "later",
      more: false,
      items: [
        { id: "first", role: "user", text: prior },
        { id: "later", role: "user", text: later },
      ],
      acknowledge() {
        acks++;
      },
    };
    const reviewer = new Reviewer({
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
                    verdict: "supported",
                    reason:
                      "The later instruction supersedes the earlier rule.",
                  }
                : {
                    action: "remove",
                    id: old.id,
                    targetAuthority: "instruction",
                    citation: { kind: "session", id: "later", quote: later },
                    supersedes: { kind: "session", id: "first", quote: prior },
                    reason: "The user changed the instruction.",
                  },
      },
    });
    assert.equal((await reviewer.review({ batch })).status, "applied");
    assert.equal(acks, 0);
    assert.equal((await store.list()).memories.length, 0);
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
