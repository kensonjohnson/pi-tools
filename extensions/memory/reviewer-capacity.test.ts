import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

async function fixture(
  fn: (cwd: string, store: MemoryManager) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "review-capacity-"));
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    await fn(cwd, store);
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("reviews more than 50 records and captures more than eight requests", () =>
  fixture(async (cwd, store) => {
    for (let i = 0; i < 55; i++)
      await store.remember("knowledge", `Distinct record ${i}.`);
    const paths = Array.from({ length: 12 }, (_, i) => `source-${i}.txt`);
    for (const path of paths) await writeFile(join(cwd, path), "Evidence.");
    let reviewed = 0,
      captured = 0;
    const reviewer = new MemoryReviewer({
      project: cwd,
      store,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) {
            reviewed = data.memories.length;
            return { paths };
          }
          captured = data.files.length;
          return {
            action: "no_change",
            reason: "Reviewed.",
            evidenceSufficient: true,
          };
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(reviewed, 55);
    assert.equal(captured, 12);
    assert.equal(result.nextOffset, undefined);
  }));

test("capacity pages retain whole records and oversized records remain unchanged", () =>
  fixture(async (cwd, store) => {
    await store.remember("knowledge", "First record " + "a".repeat(800));
    await store.remember("knowledge", "Second record " + "b".repeat(800));
    const reviewer = new MemoryReviewer({
      project: cwd,
      store,
      contextWindow: 1200,
      model: {
        generate: async ({ instruction }: any) =>
          instruction.startsWith("Select")
            ? { paths: [] }
            : {
                action: "no_change",
                reason: "Reviewed.",
                evidenceSufficient: true,
              },
      },
    });
    const first = await reviewer.review();
    assert.equal(first.nextOffset, 1);
    const second = await reviewer.review({
      fullOffset: first.nextOffset,
      fullSnapshot: first.fullSnapshot,
    });
    assert.equal(second.nextOffset, undefined);
    const huge = (
      await store.remember("knowledge", "Huge fact " + "z".repeat(10000))
    ).memory;
    let sawTruncated = false;
    const limited = new MemoryReviewer({
      project: cwd,
      store,
      contextWindow: 1200,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) {
            if (data.truncatedMemoryIds.includes(huge.id)) {
              sawTruncated = true;
              assert.ok(data.memories[0].content.length < huge.content.length);
            }
            return { paths: [] };
          }
          return {
            action: "no_change",
            reason: "Reviewed.",
            evidenceSufficient: true,
          };
        },
      },
    });
    let page = await limited.review();
    while (page.nextOffset !== undefined)
      page = await limited.review({
        fullOffset: page.nextOffset,
        fullSnapshot: page.fullSnapshot,
      });
    assert.equal(sawTruncated, true);
    assert.equal(page.audit?.coverage, "insufficient");
    assert.equal((await store.list()).memories.length, 3);
  }));

test("accepts long proposed content and reasons with complete cited evidence", () =>
  fixture(async (cwd, store) => {
    const content = "Long fact " + "x".repeat(5000);
    await writeFile(join(cwd, "fact.txt"), content);
    const reviewer = new MemoryReviewer({
      project: cwd,
      store,
      model: {
        generate: async ({ instruction, data }: any) =>
          instruction.startsWith("Select")
            ? { paths: ["fact.txt"] }
            : instruction.startsWith("Independently")
              ? { verdict: "supported", reason: "r".repeat(3000) }
              : {
                  action: "add",
                  category: "knowledge",
                  content,
                  reason: "r".repeat(3000),
                  citation: {
                    kind: "file",
                    id: data.files[0].id,
                    quote: content,
                  },
                },
      },
    });
    assert.equal((await reviewer.review()).status, "applied");
    assert.equal((await store.list()).memories[0].content, content);
  }));

test("all memory, session, metadata and evidence page combinations are reviewed before acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-fragment-product-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    await store.remember("knowledge", "memory ".repeat(2000).trim());
    await writeFile(join(root, "source.txt"), "evidence ".repeat(1600));
    const query = "absent-query".repeat(900);
    let ack = 0;
    const batch: any = {
      path: "/fake",
      sessionId: "s",
      leaf: "u",
      items: [{ id: "u", role: "user", text: "session ".repeat(2000) }],
      more: false,
      acknowledge: () => ack++,
    };
    const combinations = new Set<string>();
    let expected = 0;
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      contextWindow: 2600,
      validateSession: async () => {},
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: ["source.txt"], search: [query] };
          expected =
            data.memoryPages *
            data.sessionPages *
            data.metadataPages *
            data.evidencePages;
          const key = [
            data.memoryPage,
            data.sessionPage,
            data.metadataPage,
            data.evidencePage,
          ].join("/");
          assert.ok(!combinations.has(key));
          combinations.add(key);
          assert.ok(JSON.stringify(data).length < 10400);
          return {
            action: "no_change",
            reason: "Reviewed page.",
            evidenceSufficient: combinations.size !== 1,
          };
        },
      },
    });
    const result = await reviewer.review({ batch });
    assert.ok(expected > 1, JSON.stringify(result));
    assert.equal(combinations.size, expected);
    assert.equal(result.status, "unresolved");
    assert.equal(ack, 0);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized search query metadata is disclosed in all context-fitting pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-metadata-pages-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    await writeFile(join(root, "source.txt"), "other");
    const query = "long-query".repeat(4000);
    const chunks: string[] = [];
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      contextWindow: 3000,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: [], search: [query] };
          assert.equal(data.metadataFragmented, true);
          assert.ok(JSON.stringify(data).length < 12000);
          chunks.push(data.searches[0].query);
          return {
            action: "no_change",
            reason: "Reviewed.",
            evidenceSufficient: true,
          };
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(result.status, "unchanged");
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(""), query);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewer traverses all discovery and search pages and presents every match", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-pages-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    const count = 4105;
    for (let start = 0; start < count; start += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, count - start) }, (_, n) => {
          const i = start + n;
          return writeFile(
            join(root, `source-${String(i).padStart(4, "0")}.txt`),
            i >= count - 40 ? "needle " + "x".repeat(1000) : "other",
          );
        }),
      );
    }
    const inventory = new Set<string>();
    const matches = new Set<string>();
    let pages = 0;
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      contextWindow: 4000,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) {
            for (const path of data.repositoryPaths) inventory.add(path);
            return { paths: [], search: ["needle"] };
          }
          pages++;
          for (const file of data.files) matches.add(file.path);
          return {
            action: "no_change",
            reason: "Reviewed.",
            evidenceSufficient: true,
          };
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(inventory.size, count);
    assert.equal(matches.size, 40);
    assert.ok(pages > 1);
    assert.equal(result.status, "unchanged");
    assert.equal(result.audit?.coverage, "limited");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
