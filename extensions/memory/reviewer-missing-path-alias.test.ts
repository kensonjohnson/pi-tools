import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

test("an unfit absent path receives a host alias and complete identity fragments", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-absent-alias-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    const path = "absent/" + "longsegment/".repeat(1200) + "file.txt";
    const fragments = new Map<number, string>();
    let alias = "";
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      contextWindow: 3000,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: [], missing: [path] };
          for (const part of data.repositoryIdentityFragments) {
            alias = part.alias;
            fragments.set(part.start, part.text);
          }
          for (const file of data.files) {
            assert.equal(file.pathOmitted, true);
            assert.match(file.path, /^pi-path-/);
          }
          return {
            action: "no_change",
            reason: "Reviewed.",
            evidenceSufficient: true,
          };
        },
      },
    });
    const result = await reviewer.review();
    assert.match(alias, /^pi-path-/);
    assert.equal(
      [...fragments]
        .sort(([a], [b]) => a - b)
        .map(([, text]) => text)
        .join(""),
      path,
    );
    assert.equal(result.status, "unchanged");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
