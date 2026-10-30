import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

for (const mutation of [false, true])
  test(`host-issued path alias ${mutation ? "cannot authorize a partial-path mutation" : "preserves an unfit repository identity"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "review-path-alias-"));
    const store = new MemoryManager(root, { semanticEnabled: false });
    try {
      await store.init();
      const parts = Array.from(
        { length: 7 },
        (_, i) => `dir${i}-` + "x".repeat(110),
      );
      const relative = [...parts, "source.txt"].join("/");
      await mkdir(join(root, ...parts), { recursive: true });
      await writeFile(join(root, relative), "Source fact.");
      const discovered: string[] = [],
        reviewed: string[] = [];
      let alias = "",
        captured = 0;
      const reviewer = new MemoryReviewer({
        project: root,
        store,
        contextWindow: 1100,
        model: {
          generate: async ({ instruction, data }: any) => {
            if (instruction.startsWith("Select")) {
              if (data.repositoryPathFragment) {
                alias = data.repositoryPathFragment.alias;
                discovered.push(data.repositoryPathFragment.text);
                return { paths: [alias] };
              }
              return { paths: [] };
            }
            for (const fragment of data.repositoryIdentityFragments)
              reviewed.push(fragment.text);
            for (const file of data.files) {
              assert.equal(file.path, alias);
              assert.equal(file.pathOmitted, true);
              captured++;
            }
            return mutation
              ? {
                  action: "add",
                  category: "knowledge",
                  content: "Source fact.",
                  reason: "Source.",
                  citation: {
                    kind: "file",
                    id: data.files[0].id,
                    quote: "Source fact.",
                  },
                }
              : {
                  action: "no_change",
                  reason: "Reviewed.",
                  evidenceSufficient: true,
                };
          },
        },
      });
      const result = await reviewer.review();
      assert.match(alias, /^pi-path-/);
      assert.equal(discovered.join(""), relative);
      assert.equal(
        result.status,
        mutation ? "unresolved" : "unchanged",
        JSON.stringify(result),
      );
      assert.equal(reviewed.join(""), relative);
      assert.ok(captured > 0);
      if (mutation) assert.equal((await store.list()).memories.length, 0);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
