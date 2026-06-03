import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryManager } from "./core.ts";

function createFakeEmbeddingProvider(dimensions = 384) {
  const vectorFor = (text: string): number[] => {
    const vector = Array.from({ length: dimensions }, () => 0);
    const normalized = text.toLowerCase();
    if (normalized.includes("alpha")) {
      vector[0] = 1;
    } else if (normalized.includes("beta")) {
      vector[1] = 1;
    } else if (normalized.includes("gamma")) {
      vector[2] = 1;
    } else {
      vector[3] = 1;
    }
    return vector;
  };

  return {
    name: () => "fake-embedding",
    embed: async (text: string) => vectorFor(text),
    embedBatch: async (texts: string[]) => texts.map(vectorFor),
  };
}

async function createTempRepo() {
  return mkdtemp(join(tmpdir(), "pi-memory-"));
}

async function writeRepoFile(root: string, relativePath: string, content: string) {
  const absolutePath = join(root, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

describe("memory indexing", () => {
  let managers: MemoryManager[] = [];
  let roots: string[] = [];

  afterEach(async () => {
    for (const manager of managers) {
      await manager.close().catch(() => {});
    }
    managers = [];

    for (const root of roots) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
    roots = [];
  });

  async function createManager(root: string, semanticEnabled = true) {
    const manager = new MemoryManager(root, semanticEnabled
      ? {
          embeddingProviderFactory: () => createFakeEmbeddingProvider(),
        }
      : {
          semanticEnabled: false,
        });
    managers.push(manager);
    await manager.initialize();
    return manager;
  }

  it("retrieves stored memories and indexed file hits after full indexing", async () => {
    const root = await createTempRepo();
    roots.push(root);
    await writeRepoFile(
      root,
      "src/alpha.ts",
      "export const alpha = 'alpha feature';\nexport const beta = 'beta';\n",
    );

    const manager = await createManager(root);
    expect(manager.isSemanticAvailable()).toBe(true);
    await manager.remember("knowledge", "alpha project memory");

    const sync = await manager.syncLocalFiles({ roots: [root] });
    expect(sync.indexedFiles).toBe(1);
    expect(sync.chunksIndexed).toBeGreaterThan(0);

    const result = await manager.recall({ query: "alpha", limit: 10 });
    expect(result.searchMode).toBe("semantic");
    expect(result.memories.map((memory) => memory.content)).toContain(
      "alpha project memory",
    );
    expect(result.files.map((file) => file.path)).toContain("src/alpha.ts");
  });

  it("still recalls memories before explicit code indexing", async () => {
    const root = await createTempRepo();
    roots.push(root);

    const manager = await createManager(root);
    await manager.remember("knowledge", "standalone memory entry");

    const result = await manager.recall({ query: "standalone", limit: 10 });
    expect(result.memories.map((memory) => memory.content)).toContain(
      "standalone memory entry",
    );
    expect(result.files).toHaveLength(0);
  });

  it("targeted reindex updates one file without removing siblings", async () => {
    const root = await createTempRepo();
    roots.push(root);
    await writeRepoFile(root, "src/alpha.ts", "alpha original\n");
    await writeRepoFile(root, "src/beta.ts", "beta sibling\n");

    const manager = await createManager(root);
    await manager.syncLocalFiles({ roots: [root] });

    await writeRepoFile(root, "src/alpha.ts", "alpha updated\n");
    const sync = await manager.syncLocalFiles({
      paths: ["src/alpha.ts"],
      force: true,
    });
    expect(sync.indexedFiles).toBe(1);

    const updated = await manager.recall({ query: "alpha", limit: 10 });
    expect(updated.files.some((file) => file.path === "src/alpha.ts")).toBe(
      true,
    );
    expect(
      updated.files.some((file) => file.content.includes("alpha updated")),
    ).toBe(true);

    const sibling = await manager.recall({ query: "beta", limit: 10 });
    expect(sibling.files.map((file) => file.path)).toContain("src/beta.ts");
  });

  it("removes stale chunks when a targeted file is deleted", async () => {
    const root = await createTempRepo();
    roots.push(root);
    await writeRepoFile(root, "src/dead.ts", "zeta stale content\n");

    const manager = await createManager(root);
    await manager.syncLocalFiles({ roots: [root] });

    await rm(join(root, "src/dead.ts"));
    const sync = await manager.syncLocalFiles({
      paths: ["src/dead.ts"],
      force: true,
    });
    expect(sync.removedFiles).toBe(1);

    const result = await manager.recall({ query: "zeta", limit: 10 });
    expect(result.files.some((file) => file.path === "src/dead.ts")).toBe(
      false,
    );
  });

  it("skips unchanged files on repeat sync", async () => {
    const root = await createTempRepo();
    roots.push(root);
    await writeRepoFile(root, "src/unchanged.ts", "alpha unchanged\n");

    const manager = await createManager(root);
    const first = await manager.syncLocalFiles({ roots: [root] });
    expect(first.indexedFiles).toBe(1);

    const second = await manager.syncLocalFiles({ roots: [root] });
    expect(second.indexedFiles).toBe(0);
    expect(second.skippedFiles).toBe(1);
  });

  it("falls back to FTS when semantic search is disabled", async () => {
    const root = await createTempRepo();
    roots.push(root);
    await writeRepoFile(root, "src/fallback.ts", "alpha fallback content\n");

    const manager = await createManager(root, false);
    await manager.remember("knowledge", "alpha fallback memory");
    await manager.syncLocalFiles({ roots: [root] });

    const result = await manager.recall({ query: "alpha", limit: 10 });
    expect(result.searchMode).not.toBe("semantic");
    expect(result.memories.map((memory) => memory.content)).toContain(
      "alpha fallback memory",
    );
    expect(result.files.map((file) => file.path)).toContain("src/fallback.ts");
  });
});
