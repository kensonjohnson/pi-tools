import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

for (const incomplete of [
  "duplicate",
  "fact",
  "unscoped conflict",
  "unscoped disproof",
  "malformed unscoped disproof",
  "malformed dependent removal",
] as const) {
  test(`paired review handles ${incomplete}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "review-independent-passes-"));
    const store = new MemoryManager(cwd, { semanticEnabled: false });
    try {
      await store.init();
      const outdated = (await store.remember("knowledge", "Alpha is old."))
        .memory;
      const retained = (
        await store.remember("knowledge", "Queue data persists on disk.")
      ).memory;
      const duplicate = (
        await store.remember(
          "knowledge",
          incomplete === "malformed dependent removal"
            ? "Alpha remains old."
            : "Queue data is stored on disk.",
        )
      ).memory;
      await writeFile(join(cwd, "source.txt"), "Alpha is current.\n");
      const calls: string[] = [];
      const reviewer = new MemoryReviewer({
        project: cwd,
        store,
        model: {
          generate: async ({ instruction, data }: any) => {
            if (instruction.startsWith("Select"))
              return { paths: ["source.txt"] };
            if (instruction.includes("Review factual corrections")) {
              calls.push("fact");
              return incomplete === "fact"
                ? {
                    action: "unresolved",
                    id: outdated.id,
                    reasonKind: "evidence_gap",
                    reason: "More evidence is needed.",
                  }
                : {
                    action: "update",
                    id: outdated.id,
                    content: "Alpha is current.",
                    targetAuthority: "fact",
                    reason: "Source changed.",
                    citation: {
                      kind: "file",
                      id: data.files[0].id,
                      quote: "Alpha is current.",
                    },
                  };
            }
            if (instruction.includes("Independently review duplicate")) {
              calls.push("duplicate");
              return incomplete === "duplicate"
                ? {
                    action: "unresolved",
                    id: duplicate.id,
                    reasonKind: "evidence_gap",
                    reason: "More evidence is needed.",
                  }
                : incomplete === "malformed dependent removal"
                  ? {
                      action: "remove",
                      id: duplicate.id,
                      targetAuthority: "fact",
                      reason: "Duplicate.",
                      citation: {
                        kind: "memory",
                        id: outdated.id,
                        quote: outdated.content,
                      },
                      unexpected: true,
                    }
                  : incomplete === "unscoped disproof" ||
                      incomplete === "malformed unscoped disproof"
                    ? {
                        action: "unresolved",
                        reason:
                          "Alpha must not be updated; another source disproves this correction",
                        ...(incomplete === "malformed unscoped disproof"
                          ? { unexpected: true }
                          : {}),
                      }
                    : incomplete === "unscoped conflict"
                      ? {
                          action: "unresolved",
                          reasonKind: "conflict",
                          reason:
                            "Alpha is old, contradicting the proposed current fact.",
                        }
                      : {
                          action: "remove",
                          id: duplicate.id,
                          targetAuthority: "fact",
                          reason: "Duplicate.",
                          citation: {
                            kind: "memory",
                            id: retained.id,
                            quote: retained.content,
                          },
                        };
            }
            if (instruction.startsWith("Independently classify"))
              return {
                authority: "fact",
                noInstructionOrPreference: true,
                reason: "Fact.",
              };
            if (instruction.startsWith("Independently compare"))
              return { verdict: "irrelevant", reason: "Unrelated." };
            if (instruction.startsWith("Independently assess whether removing"))
              return {
                verdict: "supported",
                reason: "Supported.",
                fullyEntailed: true,
                noUniqueDetails: true,
                noContradiction: true,
                noExplicitInstruction: true,
              };
            if (instruction.startsWith("Independently"))
              return { verdict: "supported", reason: "Supported." };
            throw new Error(`Unexpected instruction: ${instruction}`);
          },
        },
      });
      const result = await reviewer.review();
      assert.equal(result.status, "unresolved", JSON.stringify(result));
      assert.equal(result.acknowledged, false);
      assert.ok(calls.includes("fact") && calls.includes("duplicate"));
      const memories = (await store.list()).memories;
      assert.equal(
        memories.find((m) => m.id === outdated.id)?.content,
        incomplete === "duplicate" ? "Alpha is current." : "Alpha is old.",
      );
      assert.equal(
        memories.some((m) => m.id === duplicate.id),
        incomplete !== "fact",
      );
      assert.ok(memories.some((m) => m.id === retained.id));
    } finally {
      await store.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

for (const proposal of ["fact", "duplicate"] as const) {
  for (const contradictory of [false, true]) {
    test(`${proposal} assessment receives the other pass reason${contradictory ? " and rejects a contradiction" : ""}`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), "review-pass-reasons-"));
      const store = new MemoryManager(cwd, { semanticEnabled: false });
      try {
        await store.init();
        const target = (await store.remember("knowledge", "Alpha is old."))
          .memory;
        const retained = (
          await store.remember("knowledge", "Alpha remains old.")
        ).memory;
        await writeFile(
          join(cwd, "source.txt"),
          "Alpha is current.\n\nAlpha is old.\n",
        );
        const reason = contradictory
          ? 'source.txt states both "Alpha is current." and "Alpha is old."'
          : "No other change is needed.";
        let observed: any;
        let assessmentInstruction = "";
        const reviewer = new MemoryReviewer({
          project: cwd,
          store,
          model: {
            generate: async ({ instruction, data }: any) => {
              if (instruction.startsWith("Select"))
                return { paths: ["source.txt"] };
              if (instruction.includes("Review factual corrections"))
                return proposal === "duplicate"
                  ? { action: "no_change", reason, evidenceSufficient: true }
                  : {
                      action: "update",
                      id: target.id,
                      content: "Alpha is current.",
                      targetAuthority: "fact",
                      reason: "Source changed.",
                      citation: {
                        kind: "file",
                        id: data.files[0].id,
                        quote: "Alpha is current.",
                      },
                    };
              if (instruction.includes("Independently review duplicate"))
                return proposal === "fact"
                  ? { action: "no_change", reason, evidenceSufficient: true }
                  : {
                      action: "remove",
                      id: target.id,
                      targetAuthority: "fact",
                      reason: "Duplicate.",
                      citation: {
                        kind: "memory",
                        id: retained.id,
                        quote: retained.content,
                      },
                    };
              if (instruction.startsWith("Independently classify"))
                return {
                  authority: "fact",
                  noInstructionOrPreference: true,
                  reason: "Fact.",
                };
              if (instruction.startsWith("Independently compare"))
                return { verdict: "irrelevant", reason: "Unrelated." };
              if (
                instruction.startsWith("Independently assess whether removing")
              ) {
                observed = data.passReasons;
                assessmentInstruction = instruction;
                const hasConflict = observed?.some((entry: any) =>
                  entry.reason.includes("source.txt states both"),
                );
                return {
                  verdict: hasConflict ? "uncertain" : "supported",
                  reason: "Assessed both pass reasons.",
                  fullyEntailed: !hasConflict,
                  noUniqueDetails: !hasConflict,
                  noContradiction: !hasConflict,
                  noExplicitInstruction: true,
                };
              }
              if (instruction.startsWith("Independently assess the proposal")) {
                observed = data.passReasons;
                assessmentInstruction = instruction;
                const hasConflict = observed?.some((entry: any) =>
                  entry.reason.includes("source.txt states both"),
                );
                return {
                  verdict: hasConflict ? "uncertain" : "supported",
                  reason: "Assessed both pass reasons.",
                };
              }
              throw new Error(`Unexpected instruction: ${instruction}`);
            },
          },
        });
        const result = await reviewer.review();
        assert.ok(
          observed?.some(
            (entry: any) =>
              entry.scope === (proposal === "fact" ? "duplicate" : "fact") &&
              entry.reason === reason,
          ),
          JSON.stringify(observed),
        );
        assert.match(
          assessmentInstruction,
          /passReasons.*untrusted model-generated observations/i,
        );
        assert.equal(
          result.status,
          contradictory ? "unresolved" : "applied",
          JSON.stringify(result),
        );
        if (contradictory) {
          assert.equal(result.acknowledged, false);
          assert.equal(
            (await store.list()).memories.find((m) => m.id === target.id)
              ?.content,
            target.content,
          );
        }
      } finally {
        await store.close();
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
}

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
              : instruction.includes("Independently review duplicate")
                ? {
                    action: "no_change",
                    reason: "No duplicate proposal.",
                    evidenceSufficient: true,
                  }
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
