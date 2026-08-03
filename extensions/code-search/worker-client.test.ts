import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { CodeSearchWorkerClient } from "./worker-client.ts";

async function sqliteContains(path: string, value: string): Promise<boolean> {
  const files = [path, `${path}-wal`, `${path}-shm`];
  const bytes = await Promise.all(
    files.map(async (file) => readFile(file).catch(() => Buffer.alloc(0))),
  );
  return bytes.some((file) => file.includes(Buffer.from(value)));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("worker indexes metadata and symbols without persisting source bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-code-search-worker-"));
  const databasePath = join(root, ".pi", "code-search", "index.sqlite");
  const secret = "UNIQUE_SOURCE_BODY_MUST_NOT_REACH_SQLITE";
  const querySecret = "UNIQUE_QUERY_TEXT_MUST_NOT_REACH_SQLITE";
  const worker = new CodeSearchWorkerClient();
  try {
    await Promise.all([
      mkdir(join(root, "nested")),
      mkdir(join(root, "blocked")),
      mkdir(join(root, "configured")),
    ]);
    await writeFile(
      join(root, ".gitignore"),
      "ignored.js\nnested/*.js\nblocked/\n",
    );
    await writeFile(
      join(root, "kept.js"),
      `function visible() { return "${secret}"; }\n`,
    );
    await writeFile(join(root, "ignored.js"), "function ignored() {}\n");
    await writeFile(join(root, "broken.py"), "def incomplete(:\n");
    await writeFile(join(root, "nested", ".gitignore"), "!allowed.js\n");
    await writeFile(
      join(root, "nested", "allowed.js"),
      "class Nested { run() {} }\n",
    );
    await writeFile(
      join(root, "nested", "rejected.js"),
      "function rejected() {}\n",
    );
    await writeFile(
      join(root, "blocked", "hidden.js"),
      "function hidden() {}\n",
    );
    await writeFile(
      join(root, "configured", "skip.ts"),
      "function skipped() {}\n",
    );
    await symlink(join(root, "kept.js"), join(root, "linked.js"));

    await worker.initialize(databasePath);
    for (const invalidIgnore of [
      "!kept.js",
      "/kept.js",
      "../kept.js",
      "kept\\\\.js",
    ]) {
      await assert.rejects(
        worker.refresh({ root, additionalIgnores: invalidIgnore }),
        /root-relative/i,
      );
    }
    assert.equal((await worker.status()).coverage.indexedFiles, 0);
    const first = await worker.refresh({
      root,
      additionalIgnores: "configured/**",
    });
    assert.equal(first.coverage.indexedFiles, 3);
    assert.equal(first.coverage.skippedIgnored, 4);
    assert.equal(first.coverage.skippedSymlink, 1);

    const visible = await worker.searchSymbols({ query: "visible", limit: 10 });
    assert.equal(visible.length, 1);
    assert.equal(visible[0]?.path, "kept.js");
    const nested = await worker.fileSymbols("nested/allowed.js");
    assert.deepEqual(
      nested.map((symbol) => [symbol.name, symbol.kind]),
      [
        ["Nested", "class"],
        ["run", "function"],
      ],
    );
    assert.equal(nested[1]?.parentId, nested[0]?.id);

    await unlink(join(root, "kept.js"));
    await writeFile(
      join(root, "new.ts"),
      "export function fresh() { return 1; }\n",
    );
    const second = await worker.validate({
      root,
      additionalIgnores: "configured/**",
    });
    assert.equal(second.coverage.indexedFiles, 3);
    assert.equal(
      (await worker.searchSymbols({ query: "visible", limit: 10 })).length,
      0,
    );
    assert.equal(
      (await worker.searchSymbols({ query: "fresh", limit: 10 })).length,
      1,
    );
    assert.equal(
      (await worker.searchSymbols({ query: querySecret, limit: 10 })).length,
      0,
    );

    assert.equal(await sqliteContains(databasePath, secret), false);
    assert.equal(await sqliteContains(databasePath, querySecret), false);
    assert.equal((await lstat(databasePath)).mode & 0o077, 0);
  } finally {
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker extracts AST symbols and spans for every supported language", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-code-search-symbols-"));
  const databasePath = join(root, ".pi", "code-search", "index.sqlite");
  const worker = new CodeSearchWorkerClient();
  try {
    await Promise.all([
      writeFile(
        join(root, "types.ts"),
        [
          "export interface Service { run(): void }",
          "export type ID = string",
          "export enum Kind { A }",
          "export class Thing { field = 1; method() {} }",
          "export const arrow = () => 1;",
          "",
        ].join("\n"),
      ),
      writeFile(join(root, "view.tsx"), "export const View = () => <div />;\n"),
      writeFile(
        join(root, "module.py"),
        "class Parent:\n  def child(self):\n    return 1\n\ndef top():\n  pass\n",
      ),
      writeFile(
        join(root, "module.go"),
        "package module\ntype Person struct {}\nconst X = 1\nvar Y = 2\nfunc Top() {}\n",
      ),
    ]);
    await worker.initialize(databasePath);
    await worker.refresh({ root, additionalIgnores: "" });

    const types = await worker.fileSymbols("types.ts");
    assert.deepEqual(
      types.map((symbol) => [symbol.name, symbol.kind]),
      [
        ["Service", "interface"],
        ["ID", "type"],
        ["Kind", "enum"],
        ["Thing", "class"],
        ["field", "field"],
        ["method", "function"],
        ["arrow", "function"],
      ],
    );
    assert.equal(types[4]?.parentId, types[3]?.id);
    assert.equal(types[5]?.parentId, types[3]?.id);
    assert.deepEqual(
      (await worker.fileSymbols("view.tsx")).map((symbol) => [
        symbol.name,
        symbol.kind,
      ]),
      [["View", "function"]],
    );
    const python = await worker.fileSymbols("module.py");
    assert.deepEqual(
      python.map((symbol) => [symbol.name, symbol.kind]),
      [
        ["Parent", "class"],
        ["child", "function"],
        ["top", "function"],
      ],
    );
    assert.equal(python[1]?.parentId, python[0]?.id);
    assert.deepEqual(
      (await worker.fileSymbols("module.go")).map((symbol) => [
        symbol.name,
        symbol.kind,
      ]),
      [
        ["Person", "type"],
        ["X", "constant"],
        ["Y", "variable"],
        ["Top", "function"],
      ],
    );
    for (const symbol of [...types, ...python]) {
      assert.ok(symbol.startByte < symbol.endByte);
      assert.ok(symbol.startLine >= 1);
      assert.ok(symbol.endLine >= symbol.startLine);
    }
  } finally {
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker records malformed parse status and cancellation leaves no partial refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-code-search-cancel-"));
  const databasePath = join(root, ".pi", "code-search", "index.sqlite");
  const worker = new CodeSearchWorkerClient();
  try {
    await writeFile(join(root, "broken.py"), "def incomplete(:\n");
    await worker.initialize(databasePath);
    await worker.refresh({ root, additionalIgnores: "" });

    const db = new Database(databasePath, { readonly: true });
    try {
      assert.equal(
        (
          db
            .prepare("SELECT parse_has_error FROM indexed_files WHERE path = ?")
            .get("broken.py") as { parse_has_error: number }
        ).parse_has_error,
        1,
      );
    } finally {
      db.close();
    }

    await Promise.all(
      Array.from({ length: 180 }, (_, index) =>
        writeFile(
          join(root, `large-${index}.ts`),
          `export const value${index} = ${index};\n${"// deliberately slow transient parse\n".repeat(800)}`,
        ),
      ),
    );
    const controller = new AbortController();
    const cancelled = worker.refresh({
      root,
      additionalIgnores: "",
      signal: controller.signal,
    });
    // Let discovery begin; the worker must still observe a cancellation at an
    // async traversal boundary and leave the previous transaction intact.
    await delay(5);
    controller.abort();
    await assert.rejects(cancelled, /cancelled/i);

    const afterCancellation = await worker.status();
    assert.equal(afterCancellation.coverage.indexedFiles, 1);
    const refreshed = await worker.refresh({ root, additionalIgnores: "" });
    assert.equal(refreshed.coverage.indexedFiles, 181);
  } finally {
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("optional watcher can be disabled and is cleaned up with the worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-code-search-watch-"));
  const databasePath = join(root, ".pi", "code-search", "index.sqlite");
  const worker = new CodeSearchWorkerClient();
  try {
    await writeFile(join(root, ".gitignore"), "ignored.go\n");
    await writeFile(
      join(root, "watched.go"),
      "package watched\nfunc Run() {}\n",
    );
    await worker.initialize(databasePath);
    await worker.refresh({ root, additionalIgnores: "" });
    const watching = await worker.watch({
      root,
      additionalIgnores: "",
      enabled: true,
    });
    assert.equal(watching.watching, true);
    await delay(100);
    await writeFile(
      join(root, "fresh.go"),
      "package watched\nfunc Fresh() {}\n",
    );
    await delay(350);
    assert.equal(
      (await worker.searchSymbols({ query: "Fresh", limit: 10 })).length,
      1,
    );
    await writeFile(
      join(root, "ignored.go"),
      "package watched\nfunc Ignored() {}\n",
    );
    await delay(350);
    assert.equal((await worker.status()).coverage.indexedFiles, 2);
    const stopped = await worker.watch({
      root,
      additionalIgnores: "",
      enabled: false,
    });
    assert.equal(stopped.watching, false);
  } finally {
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});
