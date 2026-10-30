import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { RepositoryEvidence } from "./reviewer-evidence.ts";

async function fixture(
  fn: (root: string, store: MemoryManager) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "review-inventory-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    await fn(root, store);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("inventory change during model decision prevents no-change acknowledgement", () =>
  fixture(async (root, store) => {
    await writeFile(join(root, "source.txt"), "Fact.");
    let ack = 0;
    const batch: any = {
      path: "/fake",
      sessionId: "s",
      leaf: "a",
      items: [{ id: "u", role: "user", text: "Review." }],
      more: false,
      acknowledge: () => ack++,
    };
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      validateSession: async () => {},
      model: {
        generate: async ({ instruction }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: ["source.txt"] };
          await writeFile(join(root, "new-source.txt"), "New evidence.");
          return {
            action: "no_change",
            reason: "Reviewed.",
            evidenceSufficient: true,
          };
        },
      },
    });
    await assert.rejects(
      reviewer.review({ batch }),
      /inventory changed or is incomplete/,
    );
    assert.equal(ack, 0);
  }));

test("search continuation passes its snapshot and rejects changed results before proposal", () =>
  fixture(async (root, store) => {
    for (let i = 0; i < 40; i++)
      await writeFile(join(root, `source-${i}.txt`), "needle");
    const original = RepositoryEvidence.prototype.search;
    let calls = 0,
      proposals = 0,
      firstSnapshot = "";
    RepositoryEvidence.prototype.search = async function (
      paths,
      query,
      options,
    ) {
      assert.equal(Object.isFrozen(paths), true);
      assert.equal(query, "needle");
      calls++;
      if (calls === 1) {
        const page = await original.call(this, paths, query, options);
        firstSnapshot = page.snapshot!;
        assert.ok(page.nextOffset);
        return page;
      }
      assert.equal(options?.snapshot, firstSnapshot);
      return { files: [], examined: 0, incomplete: true, changed: true };
    };
    try {
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
      await assert.rejects(reviewer.review(), /search continuation changed/);
      assert.equal(calls, 2);
      assert.equal(proposals, 0);
    } finally {
      RepositoryEvidence.prototype.search = original;
    }
  }));

test("incomplete initial discovery is never used by the reviewer", () =>
  fixture(async (root, store) => {
    const original = RepositoryEvidence.prototype.discover;
    RepositoryEvidence.prototype.discover = async () => ({
      paths: [],
      truncated: true,
      changed: true,
    });
    try {
      let calls = 0;
      const reviewer = new MemoryReviewer({
        project: root,
        store,
        model: {
          generate: async () => {
            calls++;
            return {};
          },
        },
      });
      const result = await reviewer.review();
      assert.equal(result.status, "unresolved");
      assert.equal(calls, 0);
    } finally {
      RepositoryEvidence.prototype.discover = original;
    }
  }));
