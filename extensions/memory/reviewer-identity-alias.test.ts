import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer as BaseMemoryReviewer } from "./reviewer.ts";

// This fixture's existing targets are descriptive facts.
class MemoryReviewer extends BaseMemoryReviewer {
  constructor(options: ConstructorParameters<typeof BaseMemoryReviewer>[0]) {
    const model = options.model;
    super({
      ...options,
      model: {
        ...model,
        generate: (request) =>
          request.instruction.includes("Independently review duplicate")
            ? Promise.resolve({
                action: "no_change",
                reason: "No duplicates.",
                evidenceSufficient: true,
              })
            : request.instruction.startsWith("Independently classify")
              ? Promise.resolve({
                  authority: "fact",
                  noInstructionOrPreference: true,
                  reason: "Descriptive fact.",
                })
              : model.generate(request),
      },
    });
  }
}
import { SessionReview } from "./session-review.ts";

test("host alias maps an unfit memory ID to its exact mutation precondition", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-memory-alias-"));
  try {
    await writeFile(join(root, "source.txt"), "New fact.");
    const id = "record-" + "x".repeat(30000);
    const raw =
      JSON.stringify({ id, content: "Old fact.", created: "2025" }) + "\n";
    const snapshots = {
      knowledge: { contents: raw, mode: 0o600 },
      practices: { contents: "", mode: 0o600 },
      decisions: { contents: "", mode: 0o600 },
    };
    let updated = 0;
    const store: any = {
      captureAddPrecondition: async () => ({ snapshots }),
      update: async (actual: string, content: string, expected: any) => {
        assert.equal(actual, id);
        assert.equal(expected.id, id);
        assert.equal(expected.rawLine, raw);
        updated++;
        return { id, content, category: "knowledge", created: "2025" };
      },
    };
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      contextWindow: 3000,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) {
            assert.equal(data.memories[0].idOmitted, true);
            assert.match(data.memories[0].id, /^pi-memory-/);
            return { paths: ["source.txt"] };
          }
          if (instruction.startsWith("Independently"))
            return { verdict: "supported", reason: "Supported." };
          return {
            action: "update",
            id: data.memories[0].id,
            content: "New fact.",
            reason: "Source.",
            targetAuthority: "fact",
            citation: {
              kind: "file",
              id: data.files[0].id,
              quote: "New fact.",
            },
          };
        },
      },
    });
    assert.equal((await reviewer.review()).status, "applied");
    assert.equal(updated, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host alias binds an unfit user-message ID to its validated source", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-session-alias-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    const dir = join(root, "sessions");
    await mkdir(dir);
    await store.init();
    const id = "message-" + "x".repeat(30000);
    await writeFile(
      join(dir, "one.jsonl"),
      [
        { type: "session", version: 3, id: "s", cwd: root },
        {
          type: "message",
          id,
          parentId: null,
          message: { role: "user", content: "Always use TLS." },
        },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    const source = new SessionReview({
      project: root,
      sessionDir: dir,
      checkpointFile: join(root, ".pi", "checkpoint.json"),
    });
    const batch = source.discover().batches[0];
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      contextWindow: 3000,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) {
            assert.equal(data.session[0].idOmitted, true);
            assert.match(data.session[0].id, /^pi-session-/);
            return { paths: [] };
          }
          if (instruction.startsWith("Independently"))
            return { verdict: "supported", reason: "Direct user instruction." };
          return {
            action: "add",
            category: "practices",
            content: "Always use TLS.",
            reason: "Direct instruction.",
            citation: {
              kind: "session",
              id: data.session[0].id,
              quote: data.session[0].text,
            },
          };
        },
      },
    });
    assert.equal((await reviewer.review({ batch })).status, "applied");
    assert.equal((await store.list()).memories[0].content, "Always use TLS.");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
