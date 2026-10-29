import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

for (const scenario of [
  {
    old: "Always use secure mode.",
    later: "Always use blue folders.",
    action: "update",
    content: "Always use blue folders.",
  },
  {
    old: "Never use secure mode.",
    later: "Stop using secure mode.",
    action: "remove",
  },
] as const)
  test(`protected instruction does not accept unrelated or reinforcing instruction: ${scenario.later}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "review-target-"));
    const store = new MemoryManager(cwd, { semanticEnabled: false });
    try {
      await store.init();
      const old = (await store.remember("practices", scenario.old)).memory;
      const batch: any = {
        path: "/fake",
        sessionId: "s",
        leaf: "b",
        more: false,
        items: [
          { id: "a", role: "user", text: scenario.old },
          { id: "b", role: "user", text: scenario.later },
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
              : {
                  action: scenario.action,
                  id: old.id,
                  ...(scenario.action === "update"
                    ? { content: scenario.content }
                    : {}),
                  targetAuthority: "instruction",
                  citation: { kind: "session", id: "b", quote: scenario.later },
                  supersedes: { kind: "session", id: "a", quote: scenario.old },
                  reason: "Claimed supersession.",
                },
        },
      });
      assert.equal((await r.review({ batch })).status, "unresolved");
      assert.equal((await store.list()).memories[0].content, scenario.old);
    } finally {
      await store.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
