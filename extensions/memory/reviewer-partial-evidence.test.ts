import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

test("partial file receipts cannot justify mutations or clean coverage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-partial-evidence-"));
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    await writeFile(join(cwd, "large.txt"), "A".repeat(300000));
    let viewed = 0;
    const reviewer = new MemoryReviewer({
      project: cwd,
      store,
      contextWindow: 3000,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) return { paths: ["large.txt"] };
          if (instruction.includes("Independently review duplicate"))
            return {
              action: "no_change",
              reason: "Reviewed.",
              evidenceSufficient: true,
            };
          assert.ok(JSON.stringify(data).length < 12000);
          viewed += data.files.reduce(
            (sum: number, file: any) => sum + file.text.length,
            0,
          );
          return {
            action: "add",
            category: "knowledge",
            content: "A fact.",
            reason: "Source.",
            citation: {
              kind: "file",
              id: data.files[0].id,
              quote: data.files[0].text,
            },
          };
        },
      },
    });
    assert.equal((await reviewer.review()).status, "unresolved");
    assert.equal(viewed, 300000);
    assert.equal((await store.list()).memories.length, 0);
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
