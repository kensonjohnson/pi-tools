import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

test("matched later direct replacement for the same subject can update protected guidance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-target-"));
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    const old = (await store.remember("practices", "Always use secure mode."))
      .memory;
    const later = "Use insecure mode.";
    const batch: any = {
      path: "/fake",
      sessionId: "s",
      leaf: "b",
      more: false,
      items: [
        { id: "a", role: "user", text: old.content },
        { id: "b", role: "user", text: later },
      ],
      acknowledge() {
        throw new Error("must not acknowledge");
      },
    };
    const r = new MemoryReviewer({
      project: cwd,
      store,
      validateSession: async () => {},
      model: {
        generate: async ({ instruction }) =>
          instruction.startsWith("Select")
            ? { paths: [] }
            : instruction.startsWith("Independently")
              ? {
                  verdict: "supported",
                  reason:
                    "Later direct instruction replaces the previous rule.",
                }
              : {
                  action: "update",
                  id: old.id,
                  content: later,
                  targetAuthority: "instruction",
                  citation: { kind: "session", id: "b", quote: later },
                  supersedes: { kind: "session", id: "a", quote: old.content },
                  reason: "The user changed the rule.",
                },
      },
    });
    assert.equal((await r.review({ batch })).status, "applied");
    assert.equal((await store.list()).memories[0].content, later);
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
