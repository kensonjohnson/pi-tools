import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

test("evidence-supported paraphrased merge updates one record and removes its duplicate in separate passes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-merge-"));
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    const first = (
      await store.remember("knowledge", "The queue stores durable data.")
    ).memory;
    const second = (
      await store.remember("knowledge", "Queue data persists on disk.")
    ).memory;
    await writeFile(
      join(cwd, "queue.txt"),
      "Queue data is stored on local disk.\n",
    );
    const create = (action: "update" | "remove") =>
      new MemoryReviewer({
        project: cwd,
        store,
        model: {
          generate: async ({ instruction, data }: any) =>
            instruction.startsWith("Select")
              ? { paths: ["queue.txt"] }
              : instruction.startsWith("Independently classify")
                ? {
                    authority: "fact",
                    noInstructionOrPreference: true,
                    reason: "Descriptive fact.",
                  }
                : instruction.startsWith("Independently")
                  ? {
                      verdict: "supported",
                      reason: "The file supports both claims.",
                    }
                  : action === "update"
                    ? {
                        action,
                        id: first.id,
                        content: "The queue persists data on local disk.",
                        targetAuthority: "fact",
                        reason:
                          "Combine the duplicate descriptions with the current source.",
                        citation: {
                          kind: "file",
                          id: data.files[0].id,
                          quote: "Queue data is stored on local disk.",
                        },
                      }
                    : {
                        action,
                        id: second.id,
                        targetAuthority: "fact",
                        reason: "The updated record covers the same fact.",
                        citation: {
                          kind: "file",
                          id: data.files[0].id,
                          quote: "Queue data is stored on local disk.",
                        },
                      },
        },
      });
    assert.equal((await create("update").review()).status, "applied");
    assert.equal((await create("remove").review()).status, "applied");
    const memories = (await store.list()).memories;
    assert.equal(memories.length, 1);
    assert.equal(memories[0].id, first.id);
    assert.equal(memories[0].content, "The queue persists data on local disk.");
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
