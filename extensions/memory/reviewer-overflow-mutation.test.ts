import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryReviewer } from "./reviewer.ts";
import { ReviewerContextOverflowError } from "./reviewer-model.ts";

test("an uncertain store mutation is never retried even if it throws the overflow type", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-overflow-mutation-"));
  try {
    await writeFile(join(root, "fact.txt"), "A supported fact.");
    let writes = 0,
      modelCalls = 0;
    const snapshots = {
      knowledge: { contents: "", mode: 0o600 },
      practices: { contents: "", mode: 0o600 },
      decisions: { contents: "", mode: 0o600 },
    };
    const store: any = {
      captureAddPrecondition: async () => ({ snapshots }),
      remember: async () => {
        writes++;
        throw new ReviewerContextOverflowError();
      },
    };
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      contextWindow: 3000,
      model: {
        generate: async ({ instruction, data }: any) => {
          modelCalls++;
          if (instruction.startsWith("Select")) return { paths: ["fact.txt"] };
          if (instruction.includes("Independently review duplicate"))
            return {
              action: "no_change",
              reason: "No duplicates.",
              evidenceSufficient: true,
            };
          if (instruction.startsWith("Independently"))
            return { verdict: "supported", reason: "Supported." };
          return {
            action: "add",
            category: "knowledge",
            content: "A supported fact.",
            reason: "Source.",
            citation: {
              kind: "file",
              id: data.files[0].id,
              quote: "A supported fact.",
            },
          };
        },
      },
    });
    assert.equal((await reviewer.review()).status, "uncertain");
    assert.equal(writes, 1);
    assert.equal(modelCalls, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
