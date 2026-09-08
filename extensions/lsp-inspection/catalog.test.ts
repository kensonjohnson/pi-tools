import assert from "node:assert/strict";
import test from "node:test";
import {
  findLspCatalogForFile,
  getLspCatalogDescriptor,
  isLspCatalogId,
  LSP_CATALOG_IDS,
  LSP_SERVER_CATALOG,
} from "./catalog.ts";

test("catalog is an immutable reviewed TypeScript, Go, and Python allowlist", () => {
  assert.deepEqual(LSP_CATALOG_IDS, ["typescript", "go", "python"]);
  assert.deepEqual(
    LSP_SERVER_CATALOG.map((descriptor) => descriptor.id),
    ["typescript", "go", "python"],
  );
  assert.equal(Object.isFrozen(LSP_SERVER_CATALOG), true);
  for (const descriptor of LSP_SERVER_CATALOG) {
    assert.equal(Object.isFrozen(descriptor), true);
    assert.equal(Object.isFrozen(descriptor.source), true);
    assert.equal(Object.isFrozen(descriptor.executable.arguments), true);
    assert.equal(Object.isFrozen(descriptor.healthProbe), true);
    assert.equal(Object.isFrozen(descriptor.healthProbe.arguments), true);
    assert.match(descriptor.version, /^v?\d+\.\d+\.\d+$/);
    assert.equal(
      Object.keys(descriptor).some((key) => /url|command|path/i.test(key)),
      false,
    );
  }

  const python = getLspCatalogDescriptor("python");
  assert.deepEqual(python.executable.arguments, ["--stdio"]);
  assert.equal(
    python.healthProbe.executableRelativePath,
    "node_modules/.bin/pyright",
  );
  assert.deepEqual(python.healthProbe.arguments, ["--version"]);
  assert.equal(python.version, "1.1.411");
  assert.deepEqual(python.source, {
    kind: "npm",
    packages: [{ name: "pyright", version: "1.1.411" }],
  });
  assert.throws(
    () => (LSP_SERVER_CATALOG as LspCatalogDescriptor[]).push(python),
    TypeError,
  );
});

test("catalog file matching and ID validation cannot select arbitrary servers", () => {
  assert.equal(findLspCatalogForFile("src/main.ts")?.id, "typescript");
  assert.equal(findLspCatalogForFile("MAIN.PY")?.id, "python");
  assert.equal(findLspCatalogForFile("cmd/main.go")?.id, "go");
  assert.equal(findLspCatalogForFile("README.md"), undefined);
  assert.equal(isLspCatalogId("typescript"), true);
  assert.equal(isLspCatalogId("../typescript"), false);
  assert.equal(isLspCatalogId("custom"), false);
});

type LspCatalogDescriptor = (typeof LSP_SERVER_CATALOG)[number];
