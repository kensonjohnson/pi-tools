import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

async function fixture(
  second: string,
  fn: (root: string, store: MemoryManager, ids: string[]) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "review-cross-page-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    await writeFile(
      join(root, "first.txt"),
      "Alpha is current.\n\nBeta is current.\n\n" + "a".repeat(6000),
    );
    await writeFile(
      join(root, "second.txt"),
      second + "\n\n" + "b".repeat(6000),
    );
    const ids: string[] = [];
    for (const content of ["Alpha is old.", "Beta is old."])
      ids.push((await store.remember("knowledge", content)).memory.id);
    await fn(root, store, ids);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
function make(
  root: string,
  store: MemoryManager,
  ids: string[],
  check: (data: any) => any,
  multiple = false,
) {
  const crosschecks: any[] = [];
  const reviewer = new MemoryReviewer({
    project: root,
    store,
    contextWindow: 3500,
    model: {
      generate: async ({ instruction, data }: any) => {
        if (instruction.startsWith("Select"))
          return { paths: ["first.txt", "second.txt"] };
        if (instruction.includes("Independently review duplicate"))
          return {
            action: "no_change",
            reason: "No duplicates.",
            evidenceSufficient: true,
          };
        if (instruction.startsWith("Independently classify"))
          return {
            authority: "fact",
            noInstructionOrPreference: true,
            reason: "Descriptive fact.",
          };
        if (instruction.startsWith("Independently compare")) {
          crosschecks.push(data);
          return check(data);
        }
        if (instruction.startsWith("Independently"))
          return {
            verdict: "supported",
            reason: "The cited paragraph supports the proposal.",
          };
        const source = data.files.find(
          (file: any) => file.path === "first.txt" && !file.fragment,
        );
        if (!source)
          return multiple
            ? {
                action: "no_change",
                evidenceSufficient: true,
                reason: "Reviewed this evidence page.",
              }
            : {
                action: "unresolved",
                id: ids[1],
                reasonKind: "evidence_gap",
                reason: "Insufficient evidence.",
              };
        return {
          proposals: ids.slice(0, multiple ? 2 : 1).map((id, index) => ({
            action: "update",
            id,
            content: `${index ? "Beta" : "Alpha"} is current.`,
            targetAuthority: "fact",
            reason: "The source changed.",
            citation: {
              kind: "file",
              id: source.id,
              quote: `${index ? "Beta" : "Alpha"} is current.`,
            },
          })),
        };
      },
    },
  });
  return { reviewer, crosschecks };
}

test("contradictory evidence hidden behind a generic gap blocks the correction", () =>
  fixture("Alpha is not current.", async (root, store, ids) => {
    const { reviewer, crosschecks } = make(root, store, ids, (data) =>
      data.evidence.text.includes("Alpha is not current.")
        ? {
            verdict: "contradiction",
            reason: "The later page contradicts Alpha.",
          }
        : {
            verdict: "no_conflict",
            reason: "No contradiction on this fragment.",
          },
    );
    const result = await reviewer.review();
    assert.equal(result.status, "unresolved", JSON.stringify(result));
    assert.equal(result.changes, undefined);
    assert.ok(
      crosschecks.some(
        (page) =>
          page.evidence.path === "second.txt" &&
          page.evidence.text.includes("Alpha is not current."),
      ),
    );
    assert.equal(
      (await store.list()).memories.find((record) => record.id === ids[0])
        ?.content,
      "Alpha is old.",
    );
  }));

test("unrelated evidence may permit a supported correction while the gap stays visible", () =>
  fixture("Unrelated queue documentation.", async (root, store, ids) => {
    const { reviewer, crosschecks } = make(root, store, ids, () => ({
      verdict: "irrelevant",
      reason: "This fragment discusses another subject.",
    }));
    const result = await reviewer.review();
    assert.equal(result.status, "unresolved", JSON.stringify(result));
    assert.deepEqual(result.changes, [{ action: "update", memoryId: ids[0] }]);
    assert.deepEqual(result.unresolvedTargets, [ids[1]]);
    assert.ok(crosschecks.some((page) => page.evidence.path === "second.txt"));
    assert.equal(result.audit?.coverage, "insufficient");
    assert.ok(result.audit?.gapReasons?.includes("fragment_insufficient"));
    assert.equal(result.acknowledged, false);
    assert.equal(
      (await store.list()).memories.find((record) => record.id === ids[0])
        ?.content,
      "Alpha is current.",
    );
  }));

test("a conflicting page blocks only the affected target", () =>
  fixture("Alpha is not current.", async (root, store, ids) => {
    const { reviewer } = make(
      root,
      store,
      ids,
      (data) =>
        data.proposal.id === ids[0] &&
        data.evidence.text.includes("Alpha is not current.")
          ? { verdict: "contradiction", reason: "Alpha conflicts." }
          : { verdict: "no_conflict", reason: "No contradiction." },
      true,
    );
    const result = await reviewer.review();
    assert.equal(result.status, "unresolved", JSON.stringify(result));
    assert.deepEqual(result.changes, [{ action: "update", memoryId: ids[1] }]);
    assert.deepEqual(result.unresolvedTargets, [ids[0]]);
    const records = (await store.list()).memories;
    assert.equal(
      records.find((record) => record.id === ids[0])?.content,
      "Alpha is old.",
    );
    assert.equal(
      records.find((record) => record.id === ids[1])?.content,
      "Beta is current.",
    );
  }));

test("contradiction about the old target can be clarified without clearing other targets", () =>
  fixture(
    "Alpha is current. Beta is uncertain. Gamma is not current.",
    async (root, store, ids) => {
      await writeFile(
        join(root, "first.txt"),
        "Alpha is current.\n\nBeta is current.\n\nGamma is current.",
      );
      ids.push((await store.remember("knowledge", "Gamma is old.")).memory.id);
      const clarifications: string[] = [];
      const reviewer = new MemoryReviewer({
        project: root,
        store,
        contextWindow: 3500,
        model: {
          generate: async ({ instruction, data }: any) => {
            if (instruction.startsWith("Select"))
              return { paths: ["first.txt", "second.txt"] };
            if (instruction.includes("Independently review duplicate"))
              return {
                action: "no_change",
                reason: "No duplicates.",
                evidenceSufficient: true,
              };
            if (instruction.startsWith("Independently classify"))
              return {
                authority: "fact",
                noInstructionOrPreference: true,
                reason: "Descriptive fact.",
              };
            if (instruction.startsWith("Clarify the previous cross-check")) {
              clarifications.push(data.proposal.id);
              return data.proposal.id === ids[0]
                ? {
                    verdict: "clear",
                    supportsProposal: true,
                    noRelevantInstructionOrCaveat: true,
                    noContraryEvidence: true,
                    reason:
                      "The evidence supports the current Alpha correction.",
                  }
                : {
                    verdict: "blocked",
                    supportsProposal: false,
                    noRelevantInstructionOrCaveat: false,
                    noContraryEvidence: false,
                    reason: "Beta remains unknown.",
                  };
            }
            if (instruction.startsWith("Independently compare")) {
              if (!data.evidence.text.includes("Gamma is not current."))
                return { verdict: "no_conflict", reason: "No conflict here." };
              if (data.proposal.id === ids[0])
                return {
                  verdict: "contradiction",
                  reason:
                    "The target is outdated and the proposed correction is supported.",
                };
              if (data.proposal.id === ids[1])
                return { verdict: "uncertain", reason: "Beta is unknown." };
              return {
                verdict: "contradiction",
                reason: "The evidence contradicts the proposed correction.",
              };
            }
            if (instruction.startsWith("Independently"))
              return {
                verdict: "supported",
                reason: "The source supports it.",
              };
            const source = data.files.find(
              (file: any) => file.path === "first.txt" && !file.fragment,
            );
            if (!source)
              return {
                action: "unresolved",
                reasonKind: "evidence_gap",
                reason: "Insufficient evidence.",
              };
            return {
              proposals: ["Alpha", "Beta", "Gamma"].map((name, index) => ({
                action: "update",
                id: ids[index],
                content: `${name} is current.`,
                targetAuthority: "fact",
                reason: "The source changed.",
                citation: {
                  kind: "file",
                  id: source.id,
                  quote: `${name} is current.`,
                },
              })),
            };
          },
        },
      });
      const result = await reviewer.review();
      assert.deepEqual(result.changes, [
        { action: "update", memoryId: ids[0] },
      ]);
      assert.deepEqual(
        new Set(result.unresolvedTargets),
        new Set(ids.slice(1)),
      );
      assert.ok(clarifications.includes(ids[0]));
      assert.ok(!clarifications.includes(ids[2]));
      const records = (await store.list()).memories;
      assert.deepEqual(
        ids.map((id) => records.find((record) => record.id === id)?.content),
        ["Alpha is current.", "Beta is old.", "Gamma is old."],
      );
    },
  ));

test("multi-target instruction ambiguity is not retried and only the clear target is written", () =>
  fixture(
    "A user instruction may prohibit changing Alpha.",
    async (root, store, ids) => {
      const calls = new Map<string, number>();
      const { reviewer } = make(
        root,
        store,
        ids,
        (data) => {
          const id = data.proposal.id;
          calls.set(id, (calls.get(id) ?? 0) + 1);
          if (id === ids[0])
            return calls.get(id) === 1
              ? {
                  verdict: "uncertain",
                  reason: "A user instruction may prohibit this change.",
                }
              : { verdict: "irrelevant", reason: "Misleading." };
          return { verdict: "irrelevant", reason: "Unrelated to Beta." };
        },
        true,
      );
      const result = await reviewer.review();
      assert.equal(calls.get(ids[0]), 1);
      assert.deepEqual(result.changes, [
        { action: "update", memoryId: ids[1] },
      ]);
      assert.deepEqual(result.unresolvedTargets, [ids[0]]);
      const records = (await store.list()).memories;
      assert.equal(
        records.find((record) => record.id === ids[0])?.content,
        "Alpha is old.",
      );
      assert.equal(
        records.find((record) => record.id === ids[1])?.content,
        "Beta is current.",
      );
    },
  ));

test("no target is written while its cross-check remains pending", () =>
  fixture("Unrelated queue documentation.", async (root, store, ids) => {
    let release!: () => void;
    let entered!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const update = store.update.bind(store);
    store.update = async (...args: Parameters<typeof store.update>) => {
      calls++;
      return update(...args);
    };
    const { reviewer } = make(
      root,
      store,
      ids,
      async () => {
        entered();
        await wait;
        return { verdict: "irrelevant", reason: "Unrelated." };
      },
      true,
    );
    const pending = reviewer.review();
    await started;
    assert.equal(calls, 0);
    assert.deepEqual(
      (await store.list()).memories.map((m) => m.content).sort(),
      ["Alpha is old.", "Beta is old."],
    );
    release();
    const result = await pending;
    assert.equal(result.changes?.length, 2);
    assert.equal(calls, 2);
  }));

test("uncertain cross-page assessment blocks the mutation", () =>
  fixture("Uncertain evidence.", async (root, store, ids) => {
    const { reviewer } = make(root, store, ids, () => ({
      verdict: "uncertain",
      reason: "Context may change the meaning.",
    }));
    const result = await reviewer.review();
    assert.equal(result.status, "unresolved");
    assert.equal(result.changes, undefined);
    assert.equal(
      (await store.list()).memories.find((record) => record.id === ids[0])
        ?.content,
      "Alpha is old.",
    );
  }));

test("a contradiction in a later streamed fragment blocks the mutation", () =>
  fixture(
    "Unrelated notes. ".repeat(1200) + "\n\nAlpha is not current.",
    async (root, store, ids) => {
      const { reviewer, crosschecks } = make(root, store, ids, (data) =>
        data.evidence.text.includes("Alpha is not current.")
          ? { verdict: "contradiction", reason: "Alpha conflicts." }
          : { verdict: "irrelevant", reason: "Unrelated fragment." },
      );
      const result = await reviewer.review();
      assert.equal(result.status, "unresolved");
      assert.ok(crosschecks.length > 1);
      assert.ok(
        crosschecks.some((page) =>
          page.evidence.text.includes("Alpha is not current."),
        ),
      );
      assert.equal(
        (await store.list()).memories.find((record) => record.id === ids[0])
          ?.content,
        "Alpha is old.",
      );
    },
  ));

test("source changes during cross-check fail revalidation before a write", () =>
  fixture("Unrelated documentation.", async (root, store, ids) => {
    let changed = false;
    const { reviewer } = make(root, store, ids, async () => {
      if (!changed) {
        changed = true;
        await writeFile(
          join(root, "second.txt"),
          "Modified while assessing.\n",
        );
      }
      return { verdict: "no_conflict", reason: "No conflict." };
    });
    await assert.rejects(reviewer.review(), /changed/);
    assert.equal(
      (await store.list()).memories.find((record) => record.id === ids[0])
        ?.content,
      "Alpha is old.",
    );
  }));

test("direct user evidence is also checked for contradictions", () =>
  fixture("Unrelated documentation.", async (root, store, ids) => {
    let acknowledged = 0;
    const batch: any = {
      path: "/fake",
      sessionId: "s",
      leaf: "u",
      items: [{ id: "u", role: "user", text: "Alpha is not current." }],
      more: false,
      acknowledge() {
        acknowledged++;
      },
    };
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      contextWindow: 3500,
      validateSession: async () => {},
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: ["first.txt", "second.txt"] };
          if (instruction.startsWith("Independently compare"))
            return data.evidence.kind === "session"
              ? {
                  verdict: "contradiction",
                  reason: "Direct user evidence contradicts Alpha.",
                }
              : { verdict: "irrelevant", reason: "Unrelated." };
          if (instruction.startsWith("Independently"))
            return { verdict: "supported", reason: "Source." };
          const source = data.files.find(
            (f: any) => f.path === "first.txt" && !f.fragment,
          );
          return source
            ? {
                action: "update",
                id: ids[0],
                content: "Alpha is current.",
                targetAuthority: "fact",
                reason: "Source.",
                citation: {
                  kind: "file",
                  id: source.id,
                  quote: "Alpha is current.",
                },
              }
            : {
                action: "no_change",
                reason: "Gap.",
                evidenceSufficient: false,
              };
        },
      },
    });
    const result = await reviewer.review({ batch });
    assert.equal(result.status, "unresolved");
    assert.equal(acknowledged, 0);
    assert.equal(
      (await store.list()).memories.find((record) => record.id === ids[0])
        ?.content,
      "Alpha is old.",
    );
  }));

test("semantic duplicate removal also checks repository evidence", () =>
  fixture("Unrelated documentation.", async (root, store) => {
    await writeFile(
      join(root, "backend.txt"),
      "The browser backend is not Chromium.\n",
    );
    const target = (
      await store.remember("knowledge", "The browser uses managed Chromium.")
    ).memory;
    const retained = (
      await store.remember(
        "knowledge",
        "Managed Chromium is the browser backend.",
      )
    ).memory;
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: ["backend.txt"] };
          if (instruction.startsWith("Independently compare"))
            return {
              verdict: "contradiction",
              reason: "Repository evidence contradicts both records.",
            };
          if (instruction.startsWith("Independently"))
            return {
              verdict: "supported",
              reason: "Semantic match.",
              fullyEntailed: true,
              noUniqueDetails: true,
              noContradiction: true,
              noExplicitInstruction: true,
            };
          return {
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
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(result.status, "unresolved");
    const records = (await store.list()).memories;
    assert.ok(records.some((record) => record.id === target.id));
    assert.ok(records.some((record) => record.id === retained.id));
  }));

test("large other evidence is streamed without losing content", () =>
  fixture("Unrelated documents. ".repeat(1200), async (root, store, ids) => {
    const { reviewer, crosschecks } = make(root, store, ids, () => ({
      verdict: "irrelevant",
      reason: "Unrelated.",
    }));
    const result = await reviewer.review();
    assert.equal(result.status, "unresolved", JSON.stringify(result));
    assert.deepEqual(result.changes, [{ action: "update", memoryId: ids[0] }]);
    assert.deepEqual(result.unresolvedTargets, [ids[1]]);
    assert.equal(result.acknowledged, false);
    const pieces = crosschecks.filter(
      (page) => page.evidence.path === "second.txt",
    );
    assert.ok(pieces.length > 1);
    let reconstructed = "";
    for (const page of pieces) {
      const { start, end } = page.evidence.range;
      assert.ok(start <= reconstructed.length);
      assert.equal(
        page.evidence.text.slice(0, reconstructed.length - start),
        reconstructed.slice(start),
      );
      reconstructed += page.evidence.text.slice(reconstructed.length - start);
      assert.equal(reconstructed.length, end);
    }
    assert.equal(
      reconstructed,
      "Unrelated documents. ".repeat(1200) + "\n\n" + "b".repeat(6000),
    );
    assert.ok(
      pieces.some(
        (page, index) =>
          index > 0 &&
          page.evidence.range.start < pieces[index - 1].evidence.range.end,
      ),
    );
  }));
