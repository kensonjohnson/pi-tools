import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function filesUnder(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await filesUnder(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

test("npm package contains runtime resources but excludes project memory and test artifacts", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-tools-package-"));
  try {
    for (const path of [
      "package.json",
      "README.md",
      "extensions",
      "lib",
      "skills",
    ])
      await cp(join(root, path), join(fixture, path), { recursive: true });
    for (const path of [
      ".pi/memory/knowledge.ndjson",
      ".pi/memory/.runtime/journal.json",
      "extensions/memory/.runtime/private.ts",
      "extensions/memory/tmp/private.ts",
      "skills/.runtime/private.md",
      "tests/private.test.ts",
    ]) {
      await mkdir(dirname(join(fixture, path)), { recursive: true });
      await writeFile(join(fixture, path), "private fixture");
    }
    const { stdout } = await exec(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: fixture, maxBuffer: 4 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.length, 1);
    const paths = new Set<string>(
      result[0].files.map((file: { path: string }) => file.path),
    );
    for (const path of paths) {
      assert.ok(!path.startsWith(".pi/"), `project state packaged: ${path}`);
      assert.ok(!path.startsWith("tests/"), `test directory packaged: ${path}`);
      assert.ok(
        !path.startsWith("extensions/code-search/"),
        `removed code-search extension packaged: ${path}`,
      );
      assert.ok(
        !/(^|\/)(?:\.runtime|tmp|fixtures)(\/|$)/.test(path),
        `runtime or fixture packaged: ${path}`,
      );
      assert.ok(!/\.test\.[cm]?[jt]s$/.test(path), `test packaged: ${path}`);
    }
    for (const path of [
      "package.json",
      "README.md",
      "extensions/pi-tools-settings.ts",
      "extensions/memory/index.ts",
      "extensions/browser-tools/index.ts",
      "lib/pi-tools-config.ts",
      "skills/research/SKILL.md",
      "skills/planning/references/ticket-store.md",
    ])
      assert.ok(paths.has(path), `missing runtime resource: ${path}`);
    const manifest = JSON.parse(
      await readFile(join(fixture, "package.json"), "utf8"),
    );
    assert.deepEqual(manifest.pi, {
      extensions: ["./extensions"],
      skills: ["./skills"],
    });
    assert.ok(
      manifest.dependencies["better-sqlite3"] &&
        manifest.peerDependencies["@earendil-works/pi-coding-agent"],
    );
    for (const directory of ["extensions", "lib"]) {
      for (const absolute of await filesUnder(join(fixture, directory))) {
        const path = relative(fixture, absolute).replaceAll("\\", "/");
        if (
          !path.endsWith(".ts") ||
          path.endsWith(".test.ts") ||
          /(^|\/)(?:\.runtime|tmp|fixtures)(\/|$)/.test(path)
        )
          continue;
        assert.ok(paths.has(path), `missing source: ${path}`);
        const source = await readFile(absolute, "utf8");
        for (const match of source.matchAll(
          /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])(\.[^"']+)\1/g,
        )) {
          const target = relative(
            fixture,
            resolve(dirname(absolute), match[2]),
          ).replaceAll("\\", "/");
          if (/\.ts$/.test(target))
            assert.ok(
              paths.has(target),
              `missing local import ${target} from ${path}`,
            );
        }
      }
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
