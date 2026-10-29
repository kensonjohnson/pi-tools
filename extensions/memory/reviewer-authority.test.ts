import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer as RealReviewer } from "./reviewer.ts";
import type { ReviewBatch } from "./session-review.ts";
const Reviewer = class extends RealReviewer {
  constructor(options: any) {
    super({ ...options, validateSession: async () => {} });
  }
};

test("later natural-language user instruction may supersede verified earlier explicit guidance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-authority-"));
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    const old = (await store.remember("practices", "Always use secure mode."))
      .memory;
    const prior = "Always use secure mode.";
    const later = "For this project, stop requiring secure mode from now on.";
    let acks = 0;
    const batch: ReviewBatch = {
      path: "/session",
      sessionId: "id",
      leaf: "later",
      more: false,
      items: [
        { id: "first", role: "user", text: prior },
        { id: "later", role: "user", text: later },
      ],
      acknowledge() {
        acks++;
      },
    };
    const reviewer = new Reviewer({
      project: cwd,
      store,
      model: {
        generate: async ({ instruction }: any) =>
          instruction.startsWith("Select")
            ? { paths: [] }
            : instruction.startsWith("Independently")
              ? {
                  verdict: "supported",
                  reason: "The later instruction supersedes the earlier rule.",
                }
              : {
                  action: "remove",
                  id: old.id,
                  targetAuthority: "instruction",
                  citation: { kind: "session", id: "later", quote: later },
                  supersedes: { kind: "session", id: "first", quote: prior },
                  reason: "The user changed the instruction.",
                },
      },
    });
    assert.equal((await reviewer.review({ batch })).status, "applied");
    assert.equal(acks, 0);
    assert.equal((await store.list()).memories.length, 0);
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
