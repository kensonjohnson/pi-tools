import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { RepositoryEvidence } from "./reviewer-evidence.ts";
import { reviewAllMemories } from "./manual-review.ts";

async function fixture(
  fn: (root: string, store: MemoryManager) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "memory-audit-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    await fn(root, store);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("full review finds stale browser evidence via discovery and reports a limited audit", () =>
  fixture(async (root, store) => {
    await mkdir(join(root, "extensions", "browser-tools"), { recursive: true });
    await writeFile(
      join(root, "extensions", "browser-tools", "index.ts"),
      "Browser Tools registers managed Playwright Chromium.\n",
    );
    await store.remember(
      "knowledge",
      "Browser Tools uses a hard-coded macOS Brave executable.",
    );
    let selection: any;
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) {
            selection = data;
            return { paths: ["extensions/browser-tools/index.ts"] };
          }
          assert.match(instruction, /stale.*duplicate.*contradict/i);
          assert.match(data.files[0].text, /Playwright/);
          return {
            action: "unresolved",
            reason: "Browser memory contradicts the current implementation.",
          };
        },
      },
    });
    const result = await reviewer.review();
    assert.ok(
      selection.repositoryPaths.includes("extensions/browser-tools/index.ts"),
    );
    assert.equal(result.status, "unresolved");
  }));

test("cross-page candidates include likely duplicates", () =>
  fixture(async (root, store) => {
    await writeFile(
      join(root, "browser.txt"),
      "Managed Chromium browser uses Playwright.\n",
    );
    await store.remember(
      "knowledge",
      "Managed Chromium browser uses Playwright.",
    );
    for (let i = 0; i < 49; i++)
      await store.remember(
        "knowledge",
        `Unrelated distinct record number ${i}.`,
      );
    await store.remember(
      "knowledge",
      "Playwright powers the managed Chromium browser.",
    );
    let candidates: any[] = [];
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) {
            candidates = data.crossPageCandidates;
            return { paths: ["browser.txt"] };
          }
          return {
            action: "no_change",
            reason: "No supported mutation found in supplied evidence.",
            evidenceSufficient: true,
          };
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(result.nextOffset, 50);
    assert.equal(result.audit?.coverage, "limited");
    assert.ok(
      candidates.some((x) => x.content.includes("powers the managed Chromium")),
    );
  }));

test("empty evidence and unsupported sufficiency do not yield clean review", () =>
  fixture(async (root, store) => {
    await store.remember("knowledge", "Browser uses Brave.");
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction }: any) =>
          instruction.startsWith("Select")
            ? { paths: [] }
            : {
                action: "no_change",
                evidenceSufficient: true,
                reason: "Nothing found.",
              },
      },
    });
    const result = await reviewer.review();
    assert.equal(result.status, "unchanged");
    assert.match(result.detail, /insufficient/i);
    assert.equal(result.audit?.coverage, "insufficient");
  }));

test("insufficient evidence on the first page does not skip later pages", () =>
  fixture(async (root, store) => {
    for (let i = 0; i < 51; i++)
      await store.remember("knowledge", `Record number ${i}.`);
    const seen: number[] = [];
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) {
            seen.push(data.memories.length);
            return { paths: [] };
          }
          return {
            action: "no_change",
            evidenceSufficient: false,
            reason: "Sources are missing.",
          };
        },
      },
    });
    const outcome = await reviewAllMemories({
      reviewer,
      signal: new AbortController().signal,
    });
    assert.deepEqual(seen, [50, 1]);
    assert.equal(outcome.review?.pages, 2);
    assert.equal(outcome.review?.evidenceGaps, 2);
  }));

test("short exact cross-page duplicates can use a snapshot-bound memory citation", () =>
  fixture(async (root, store) => {
    const first = (await store.remember("knowledge", "Uses Go.")).memory;
    for (let i = 0; i < 49; i++)
      await store.remember("knowledge", `Distinct record ${i}.`);
    const duplicate = {
      id: "duplicate-cross-page",
      content: "Uses Go.",
      created: "2024",
    };
    await appendFile(
      join(root, ".pi/memory/knowledge.ndjson"),
      JSON.stringify(duplicate) + "\n",
    );
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) {
            assert.ok(
              data.crossPageCandidates.some((m: any) => m.id === duplicate.id),
            );
            return { paths: [] };
          }
          if (instruction.startsWith("Independently"))
            return {
              verdict: "supported",
              reason: "Exact same-category duplicate.",
            };
          return {
            action: "remove",
            id: first.id,
            targetAuthority: "fact",
            citation: {
              kind: "memory",
              id: duplicate.id,
              quote: duplicate.content,
            },
            reason: "Exact duplicate.",
          };
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(result.status, "applied");
    assert.ok(
      (
        await store.captureAddPrecondition()
      ).snapshots.knowledge.contents.includes(duplicate.id),
    );
  }));

test("unaddressed exact duplicates are unresolved rather than clean", () =>
  fixture(async (root, store) => {
    await store.remember("knowledge", "Uses Go.");
    await appendFile(
      join(root, ".pi/memory/knowledge.ndjson"),
      JSON.stringify({
        id: "duplicate",
        content: "Uses Go.",
        created: "2024",
      }) + "\n",
    );
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction }: any) =>
          instruction.startsWith("Select")
            ? { paths: [] }
            : {
                action: "no_change",
                evidenceSufficient: false,
                reason: "No source.",
              },
      },
    });
    const result = await reviewer.review();
    assert.equal(result.status, "unresolved");
    assert.match(result.detail, /duplicate/i);
  }));

test("duplicate guidance remains protected even with a memory citation", () =>
  fixture(async (root, store) => {
    const first = (await store.remember("practices", "Always use Go.")).memory;
    await appendFile(
      join(root, ".pi/memory/practices.ndjson"),
      JSON.stringify({
        id: "duplicate-guidance",
        content: "Always use Go.",
        created: "2024",
      }) + "\n",
    );
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction }: any) =>
          instruction.startsWith("Select")
            ? { paths: [] }
            : {
                action: "remove",
                id: first.id,
                targetAuthority: "fact",
                citation: {
                  kind: "memory",
                  id: "duplicate-guidance",
                  quote: "Always use Go.",
                },
                reason: "Duplicate.",
              },
      },
    });
    const result = await reviewer.review();
    assert.equal(result.status, "unresolved");
    assert.match(result.detail, /protected/i);
  }));

test("incremental evidence gaps never acknowledge and empty inventory search is incomplete", () =>
  fixture(async (root, store) => {
    await store.remember("knowledge", "Uses Go.");
    let ack = 0;
    const batch: any = {
      path: "/fake",
      sessionId: "session",
      leaf: "leaf",
      items: [{ id: "u", role: "user", text: "Check Go." }],
      more: false,
      acknowledge: () => ack++,
    };
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      validateSession: async () => {},
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: [], search: ["Go"] };
          assert.equal(data.searches[0].examined, 0);
          assert.equal(data.searches[0].incomplete, true);
          return {
            action: "no_change",
            evidenceSufficient: false,
            reason: "Need more evidence.",
          };
        },
      },
    });
    const result = await reviewer.review({ batch });
    assert.equal(result.status, "unresolved");
    assert.equal(result.acknowledged, false);
    assert.equal(ack, 0);
    assert.equal(
      (await new RepositoryEvidence(root).search([], "Go")).incomplete,
      true,
    );
  }));

test("host rejects claimed sufficiency when a requested search is incomplete", () =>
  fixture(async (root, store) => {
    await store.remember("knowledge", "Uses Go.");
    for (let i = 0; i < 101; i++)
      await writeFile(
        join(root, `source-${String(i).padStart(3, "0")}.txt`),
        "Go project.\n",
      );
    let ack = 0;
    const batch: any = {
      path: "/fake",
      sessionId: "session",
      leaf: "leaf",
      items: [{ id: "u", role: "user", text: "Check Go." }],
      more: false,
      acknowledge: () => ack++,
    };
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      validateSession: async () => {},
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: ["source-000.txt"], search: ["absent-token"] };
          assert.equal(data.searches[0].incomplete, true);
          return {
            action: "no_change",
            evidenceSufficient: true,
            reason: "Model claims coverage is sufficient.",
          };
        },
      },
    });
    const incremental = await reviewer.review({ batch });
    assert.equal(incremental.status, "unresolved");
    assert.equal(incremental.audit?.coverage, "insufficient");
    assert.equal(incremental.audit?.searchIncomplete, true);
    assert.equal(incremental.acknowledged, false);
    assert.equal(ack, 0);
    const full = await reviewer.review();
    assert.equal(full.status, "unchanged");
    assert.equal(full.audit?.coverage, "insufficient");
    assert.equal(full.audit?.searchIncomplete, true);
  }));

test("missing-path and large-file excerpts are host-verified and revalidated", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-evidence-"));
  try {
    await writeFile(
      join(root, "large.ts"),
      `${"x".repeat(70000)}\n\nBrowser uses Playwright.\n\nEnd.\n`,
    );
    const evidence = new RepositoryEvidence(root);
    const inventory = await evidence.discover();
    const search = await evidence.search(
      inventory.paths,
      "Browser uses Playwright",
    );
    assert.equal(search.incomplete, false);
    assert.equal(search.files[0].text, "Browser uses Playwright.");
    const excerpt = await evidence.excerpt(
      "large.ts",
      "Browser uses Playwright",
    );
    assert.equal(excerpt.text, "Browser uses Playwright.");
    await evidence.verify(excerpt.id, excerpt.text);
    const absent = await evidence.missing("old/browser.ts");
    await evidence.verify(absent.id, absent.text);
    await mkdir(join(root, "old"));
    await writeFile(join(root, "old", "browser.ts"), "restored");
    await assert.rejects(evidence.revalidate(absent.id), /exists/);
    await writeFile(
      join(root, "large.ts"),
      "Browser uses Playwright.\n\nChanged.\n",
    );
    await assert.rejects(evidence.revalidate(excerpt.id), /changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
