import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

async function fixture(
  fn: (root: string, store: MemoryManager) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "review-instruction-wording-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    await writeFile(join(root, "source.txt"), "Current repository evidence.\n");
    await fn(root, store);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

const instructions = [
  "Please format outputs as JSON.",
  "I'd prefer terse responses.",
  "The user requested short answers.",
  "Don’t publish without consent.",
];
for (const [index, content] of instructions.entries())
  for (const action of (index === 0
    ? ["remove", "update"]
    : [index % 2 ? "remove" : "update"]) as ("remove" | "update")[]) {
    test(`repository evidence cannot ${action} directive: ${content}`, () =>
      fixture(async (root, store) => {
        const old = (await store.remember("knowledge", content)).memory;
        let assessments = 0;
        const reviewer = new MemoryReviewer({
          project: root,
          store,
          model: {
            generate: async ({ instruction, data }: any) => {
              if (instruction.startsWith("Select"))
                return { paths: ["source.txt"] };
              if (instruction.includes("Independently review duplicate"))
                return {
                  action: "no_change",
                  reason: "No duplicates.",
                  evidenceSufficient: true,
                };
              if (instruction.startsWith("Independently")) {
                assessments++;
                return { verdict: "supported", reason: "Supported." };
              }
              return {
                action,
                id: old.id,
                ...(action === "update"
                  ? { content: "Repository evidence supersedes the old fact." }
                  : {}),
                targetAuthority: "fact",
                citation: {
                  kind: "file",
                  id: data.files[0].id,
                  quote: "Current repository evidence.",
                },
                reason: "Repository changed.",
              };
            },
          },
        });
        const result = await reviewer.review();
        assert.equal(result.status, "unresolved", JSON.stringify(result));
        assert.match(result.detail, /protected/);
        assert.equal(assessments, 0);
        assert.equal((await store.list()).memories[0].content, content);
      }));
  }

test("ordinary stale facts remain eligible for source-supported updates", () =>
  fixture(async (root, store) => {
    const old = (await store.remember("knowledge", "Outputs use JSON.")).memory;
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: ["source.txt"] };
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
          if (instruction.startsWith("Independently"))
            return { verdict: "supported", reason: "Evidence." };
          return {
            action: "update",
            id: old.id,
            content: "Outputs use YAML.",
            targetAuthority: "fact",
            citation: {
              kind: "file",
              id: data.files[0].id,
              quote: "Current repository evidence.",
            },
            reason: "Source changed.",
          };
        },
      },
    });
    assert.equal((await reviewer.review()).status, "applied");
    assert.equal((await store.list()).memories[0].content, "Outputs use YAML.");
  }));

test("later direct instruction can supersede a matched polite instruction", () =>
  fixture(async (root, store) => {
    const old = (
      await store.remember("knowledge", "Please format outputs as JSON.")
    ).memory;
    const later = "Format outputs as XML instead of JSON.";
    const batch: any = {
      path: "/session",
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
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      validateSession: async () => {},
      model: {
        generate: async ({ instruction }: any) => {
          if (instruction.startsWith("Select")) return { paths: [] };
          if (instruction.includes("Independently review duplicate"))
            return {
              action: "no_change",
              reason: "No duplicates.",
              evidenceSufficient: true,
            };
          if (instruction.startsWith("Independently"))
            return {
              verdict: "supported",
              reason: "The later instruction replaces the earlier one.",
            };
          return {
            action: "update",
            id: old.id,
            content: later,
            targetAuthority: "fact",
            citation: { kind: "session", id: "b", quote: later },
            supersedes: { kind: "session", id: "a", quote: old.content },
            reason: "Instruction changed.",
          };
        },
      },
    });
    assert.equal((await reviewer.review({ batch })).status, "applied");
    assert.equal((await store.list()).memories[0].content, later);
  }));
