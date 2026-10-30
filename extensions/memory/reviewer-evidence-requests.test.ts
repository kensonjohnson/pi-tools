import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryReviewer } from "./reviewer.ts";

async function fixture(fn: (root: string, store: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "review-requests-"));
  const snapshots = {
    knowledge: {
      contents:
        JSON.stringify({
          id: "one",
          content: "Browser uses Playwright.",
          created: "2025-01-01",
        }) + "\n",
      mode: 0o600,
    },
    practices: { contents: "", mode: 0o600 },
    decisions: { contents: "", mode: 0o600 },
  };
  const store = {
    captureAddPrecondition: async () => ({ snapshots }),
    remember: async () => {
      throw new Error("unexpected write");
    },
    update: async () => {
      throw new Error("unexpected write");
    },
    forget: async () => {
      throw new Error("unexpected write");
    },
    move: async () => {
      throw new Error("unexpected write");
    },
  };
  try {
    await mkdir(join(root, "extensions/browser-tools"), { recursive: true });
    await fn(root, store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("multiple large captures can acknowledge incremental review", () =>
  fixture(async (root, store) => {
    await writeFile(
      join(root, "extensions/browser-tools/first.ts"),
      "a".repeat(60 * 1024),
    );
    await writeFile(
      join(root, "extensions/browser-tools/second.ts"),
      "b".repeat(60 * 1024),
    );
    let ack = 0;
    const batch: any = {
      path: "/fake",
      sessionId: "session",
      leaf: "leaf",
      items: [{ id: "u", role: "user", text: "Check browser." }],
      more: false,
      acknowledge: () => ack++,
    };
    let input: any;
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      validateSession: async () => {},
      model: {
        generate: async ({ instruction, data }) => {
          if (instruction.startsWith("Select"))
            return {
              paths: [
                "extensions/browser-tools/first.ts",
                "extensions/browser-tools/second.ts",
              ],
            };
          input = data;
          return noChange;
        },
      },
    });
    const result = await reviewer.review({ batch });
    assert.equal(input.files.length, 2);
    assert.equal(input.evidenceFailures.length, 0);
    assert.equal(result.status, "unchanged");
    assert.equal(result.audit?.coverage, "limited");
    assert.equal(ack, 1);
  }));

const noChange = {
  action: "no_change",
  reason: "Reviewed available evidence.",
  evidenceSufficient: true,
};

test("eight paths plus eight excerpts are all captured", () =>
  fixture(async (root, store) => {
    const paths = Array.from(
      { length: 8 },
      (_, i) => `extensions/browser-tools/${i}.ts`,
    );
    for (const path of paths)
      await writeFile(join(root, path), "Playwright evidence\n");
    let decisionInput: any;
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction, data }) => {
          if (instruction.startsWith("Select"))
            return {
              paths,
              excerpts: paths.map((path) => ({ path, query: "Playwright" })),
            };
          decisionInput = data;
          return noChange;
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(decisionInput.files.length, 16);
    assert.equal(decisionInput.requestsTruncated, false);
    assert.equal(result.audit?.coverage, "limited");
    assert.equal(result.acknowledged, false);
  }));

test("mixed unavailable requests reach the model safely and make no-change insufficient", () =>
  fixture(async (root, store) => {
    await writeFile(
      join(root, "extensions/browser-tools/index.ts"),
      "Playwright evidence\n",
    );
    await writeFile(
      join(root, "extensions/browser-tools/sessions.ts"),
      "x".repeat(70 * 1024),
    );
    let input: any;
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction, data }) => {
          if (instruction.startsWith("Select"))
            return {
              paths: [
                "extensions/browser-tools/index.ts",
                "extensions/browser-tools/absent.ts",
                "extensions/browser-tools",
                "extensions/browser-tools/sessions.ts",
                "../secret",
              ],
              excerpts: [
                { path: "extensions/browser-tools/index.ts", query: "absent" },
              ],
              missing: ["extensions/browser-tools/index.ts"],
            };
          input = data;
          return noChange;
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(input.files.length, 2);
    assert.deepEqual(
      input.evidenceFailures.map((f: any) => f.reason),
      [
        "not_found",
        "not_regular_or_too_large",
        "invalid_path",
        "no_match",
        "path_exists",
      ],
    );
    assert.ok(!JSON.stringify(input.evidenceFailures).includes(root));
    assert.equal(result.status, "unchanged");
    assert.equal(result.acknowledged, false);
    assert.equal(result.audit?.coverage, "insufficient");
  }));

test("a supported correction can use captured evidence despite unrelated gaps", () =>
  fixture(async (root, store) => {
    const paths = Array.from(
      { length: 8 },
      (_, i) => `extensions/browser-tools/${i}.ts`,
    );
    for (const path of paths.slice(0, 7))
      await writeFile(join(root, path), "Browser uses Chromium.\n");
    let writes = 0;
    store.update = async (id: string, content: string) => {
      writes++;
      assert.equal(id, "one");
      assert.equal(content, "Browser uses Chromium.");
      return { id, content, category: "knowledge", created: "2025-01-01" };
    };
    let assessments = 0;
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select"))
            return {
              paths,
              excerpts: paths.map((path) => ({ path, query: "Chromium" })),
            };
          if (instruction.startsWith("Independently")) {
            assessments++;
            assert.equal(data.requestsTruncated, false);
            assert.equal(data.evidenceFailures[0].reason, "not_found");
            return {
              verdict: "supported",
              reason: "The source supports the correction.",
            };
          }
          return {
            action: "update",
            id: "one",
            content: "Browser uses Chromium.",
            citation: {
              kind: "file",
              id: data.files[0].id,
              quote: "Browser uses Chromium.",
            },
            reason: "Correct stale browser fact.",
            targetAuthority: "fact",
          };
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(result.status, "applied");
    assert.equal(result.acknowledged, false);
    assert.equal(result.audit?.coverage, "insufficient");
    assert.equal(writes, 1);
    assert.equal(assessments, 1);
  }));

test("a fabricated citation for unavailable evidence is rejected before assessment or write", () =>
  fixture(async (root, store) => {
    let assessed = false;
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction }) => {
          if (instruction.startsWith("Select"))
            return { paths: ["extensions/browser-tools/missing.ts"] };
          if (instruction.startsWith("Independently")) {
            assessed = true;
            return { verdict: "supported", reason: "Claim." };
          }
          return {
            action: "update",
            id: "one",
            content: "Browser uses Chromium.",
            citation: {
              kind: "file",
              id: "missing-receipt",
              quote: "Browser uses Chromium.",
            },
            reason: "Claim.",
            targetAuthority: "fact",
          };
        },
      },
    });
    await assert.rejects(reviewer.review(), /unknown evidence receipt/);
    assert.equal(assessed, false);
  }));

test("duplicate requests are deduplicated and all searches are processed", () =>
  fixture(async (root, store) => {
    await writeFile(
      join(root, "extensions/browser-tools/index.ts"),
      "Playwright evidence\n",
    );
    let input: any;
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction, data }) => {
          if (instruction.startsWith("Select"))
            return {
              paths: [
                "extensions/browser-tools/index.ts",
                "extensions/browser-tools/index.ts",
              ],
              search: ["one", "two", "three", "four"],
            };
          input = data;
          return noChange;
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(input.searches.length, 4);
    assert.equal(input.requestsTruncated, false);
    assert.equal(result.audit?.coverage, "limited");
  }));
