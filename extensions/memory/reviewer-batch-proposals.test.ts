import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

async function fixture(
  fn: (root: string, store: MemoryManager, ids: string[]) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "memory-batch-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    await writeFile(
      join(root, "source.txt"),
      "Alpha is current.\n\nBeta is current.\n",
    );
    const a = await store.remember("knowledge", "Alpha is old.");
    const b = await store.remember("knowledge", "Beta is old.");
    await fn(root, store, [a.memory.id, b.memory.id]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
function reviewer(
  root: string,
  store: any,
  ids: string[],
  alter?: (proposals: any[]) => void,
  assess?: () => Promise<void>,
) {
  return new MemoryReviewer({
    project: root,
    store,
    model: {
      generate: async ({ instruction, data }: any) => {
        if (instruction.startsWith("Select")) return { paths: ["source.txt"] };
        if (instruction.startsWith("Independently classify"))
          return {
            authority: "fact",
            noInstructionOrPreference: true,
            reason: "Descriptive fact.",
          };
        if (instruction.startsWith("Independently")) {
          await assess?.();
          return {
            verdict: "supported",
            reason: "Source supports the correction.",
          };
        }
        assert.match(instruction, /independently supported changes/);
        const proposals = ids.map((id, i) => ({
          action: "update",
          id,
          content: `${i ? "Beta" : "Alpha"} is current.`,
          targetAuthority: "fact",
          reason: "Source changed.",
          citation: {
            kind: "file",
            id: data.files[0].id,
            quote: `${i ? "Beta" : "Alpha"} is current.`,
          },
        }));
        alter?.(proposals);
        return { proposals };
      },
    },
  });
}

test("batch applies independent corrections with sequential snapshots", () =>
  fixture(async (root, store, ids) => {
    const result = await reviewer(root, store, ids).review();
    assert.equal(result.status, "applied");
    assert.deepEqual(
      result.changes,
      ids.map((memoryId) => ({ action: "update", memoryId })),
    );
    assert.equal(result.memoryId, ids[0]);
    assert.deepEqual(
      (await store.list()).memories.map((m) => m.content).sort(),
      ["Alpha is current.", "Beta is current."],
    );
  }));

test("batch adds multiple independent facts using refreshed snapshots", () =>
  fixture(async (root, store) => {
    await writeFile(
      join(root, "source.txt"),
      "Gamma is current.\n\nDelta is current.\n",
    );
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: ["source.txt"] };
          if (instruction.startsWith("Independently"))
            return { verdict: "supported", reason: "Source." };
          return {
            proposals: ["Gamma is current.", "Delta is current."].map(
              (content) => ({
                action: "add",
                category: "knowledge",
                content,
                reason: "Source.",
                citation: {
                  kind: "file",
                  id: data.files[0].id,
                  quote: content,
                },
              }),
            ),
          };
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(result.status, "applied");
    assert.equal(result.changes?.length, 2);
    assert.deepEqual(
      result.changes?.map((change) => change.action),
      ["add", "add"],
    );
    const contents = (await store.list()).memories.map((m) => m.content);
    assert.ok(contents.includes("Gamma is current."));
    assert.ok(contents.includes("Delta is current."));
  }));

test("batch reports confirmed prefix when a later source reference is invalid", () =>
  fixture(async (root, store, ids) => {
    const result = await reviewer(root, store, ids, (p) => {
      p[1].citation.id = "forged";
    }).review();
    assert.equal(result.status, "unresolved");
    assert.deepEqual(result.changes, [{ action: "update", memoryId: ids[0] }]);
    assert.deepEqual(
      (await store.list()).memories.map((m) => m.content).sort(),
      ["Alpha is current.", "Beta is old."],
    );
  }));

test("batch preserves confirmed prefix when a later write outcome is uncertain", () =>
  fixture(async (root, store, ids) => {
    const update = store.update.bind(store);
    let calls = 0;
    store.update = async (...args: Parameters<typeof store.update>) => {
      calls++;
      const result = await update(...args);
      if (calls === 2) throw new Error("simulated index failure");
      return result;
    };
    const result = await reviewer(root, store, ids).review();
    assert.equal(result.status, "uncertain");
    assert.deepEqual(result.changes, [{ action: "update", memoryId: ids[0] }]);
    assert.equal(calls, 2);
  }));

test("an intervening edit stops the batch without overwriting it", () =>
  fixture(async (root, store, ids) => {
    let assessments = 0;
    const result = await reviewer(root, store, ids, undefined, async () => {
      if (++assessments === 2)
        await store.remember("knowledge", "Independent external fact.");
    }).review();
    assert.equal(result.status, "unresolved");
    assert.deepEqual(result.changes, [{ action: "update", memoryId: ids[0] }]);
    const contents = (await store.list()).memories.map((m) => m.content);
    assert.ok(contents.includes("Independent external fact."));
    assert.ok(contents.includes("Beta is old."));
  }));

test("dependent proposals are rejected before writes", () =>
  fixture(async (root, store, ids) => {
    await assert.rejects(
      reviewer(root, store, ids, (p) => {
        p[1].id = p[0].id;
      }).review(),
      /dependent reviewer proposals/,
    );
    assert.deepEqual(
      (await store.list()).memories.map((m) => m.content).sort(),
      ["Alpha is old.", "Beta is old."],
    );
  }));

test("later protected instructions cannot be changed by repository evidence", () =>
  fixture(async (root, store, ids) => {
    await store.update(ids[1], "Always use Beta.");
    const result = await reviewer(root, store, ids).review();
    assert.equal(result.status, "unresolved");
    assert.deepEqual(result.changes, [{ action: "update", memoryId: ids[0] }]);
    assert.ok(
      (await store.list()).memories.some(
        (m) => m.content === "Always use Beta.",
      ),
    );
  }));
