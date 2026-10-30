import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { RepositoryEvidence } from "./reviewer-evidence.ts";

test("inventory change after a proposal prevents assessment and mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-inventory-proposal-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    await writeFile(join(root, "source.txt"), "Fact.");
    let assessments = 0;
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: ["source.txt"] };
          if (instruction.startsWith("Independently")) {
            assessments++;
            return { verdict: "supported", reason: "Supported." };
          }
          await writeFile(join(root, "later.txt"), "Conflicting fact.");
          return {
            action: "add",
            category: "knowledge",
            content: "Fact.",
            reason: "Source.",
            citation: { kind: "file", id: data.files[0].id, quote: "Fact." },
          };
        },
      },
    });
    await assert.rejects(
      reviewer.review(),
      /inventory changed or is incomplete/,
    );
    assert.equal(assessments, 0);
    assert.equal((await store.list()).memories.length, 0);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("inventory change between search pages aborts before a proposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-inventory-search-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  const original = RepositoryEvidence.prototype.search;
  try {
    await store.init();
    for (let i = 0; i < 40; i++)
      await writeFile(join(root, `source-${i}.txt`), "needle");
    let searches = 0,
      proposals = 0;
    RepositoryEvidence.prototype.search = async function (
      paths,
      query,
      options,
    ) {
      const page = await original.call(this, paths, query, options);
      if (++searches === 1) await writeFile(join(root, "new.txt"), "needle");
      return page;
    };
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: [], search: ["needle"] };
          proposals++;
          return {
            action: "no_change",
            reason: "Reviewed.",
            evidenceSufficient: true,
          };
        },
      },
    });
    await assert.rejects(
      reviewer.review(),
      /inventory changed or is incomplete/,
    );
    assert.equal(searches, 1);
    assert.equal(proposals, 0);
  } finally {
    RepositoryEvidence.prototype.search = original;
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
