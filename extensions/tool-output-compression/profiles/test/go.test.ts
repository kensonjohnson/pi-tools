import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  GO_TEST_REFERENCE_ID_PLACEHOLDER,
  analyzeGoTestOutput,
  goTestProfile,
  isGoTestReplacementSmaller,
  renderGoTestProfile,
} from "./go.ts";

const fixture = (name: string) =>
  readFile(
    fileURLToPath(new URL(`./fixtures/go/${name}`, import.meta.url)),
    "utf8",
  );

test("summarizes a successful verbose Go-test region", async () => {
  const raw = await fixture("verbose-success.txt");
  const analysis = analyzeGoTestOutput(raw);
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;

  assert.deepEqual(
    analysis.profile.packages.map((entry) => entry.kind),
    ["ok", "no-test-files", "ok"],
  );
  assert.equal(analysis.profile.passEntries, 2);
  const compact = renderGoTestProfile(
    analysis.profile,
    GO_TEST_REFERENCE_ID_PLACEHOLDER,
  );
  assert.match(compact, /Verbose details omitted: 2 PASS entries\./);
  assert.match(compact, /Go unit tests passed: 2 tested packages/);
  assert.equal(isGoTestReplacementSmaller(raw, compact), true);
});

test("summarizes normal Go package output without a verbose-detail line", async () => {
  const normal = await fixture("normal-success.txt");
  const analysis = analyzeGoTestOutput(normal);
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;
  assert.equal(analysis.profile.kind, "normal");
  const compact = renderGoTestProfile(analysis.profile, "id");
  assert.match(
    compact,
    /Go unit tests passed: 8 tested packages \(7 cached\); 2 packages had no tests\./,
  );
  assert.doesNotMatch(compact, /Verbose details omitted/);
  assert.equal(isGoTestReplacementSmaller(normal, compact), true);
});

test("adapts Go analysis to the generic profile contract", async () => {
  const raw = await fixture("verbose-success.txt");
  assert.equal(goTestProfile.id, "go-test");
  assert.equal(goTestProfile.mayMatch(raw), true);
  const analysis = goTestProfile.analyze(raw);
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;
  assert.deepEqual(analysis.summary, {
    testedPackages: 2,
    cachedPackages: 1,
    noTestPackages: 1,
    passEntries: 2,
  });
});

test("rejects failed, malformed, composite, unrelated, and never-worse output", async () => {
  const [failed, composite] = await Promise.all([
    fixture("verbose-failure.txt"),
    fixture("composite-output.txt"),
  ]);
  assert.deepEqual(analyzeGoTestOutput(failed), {
    applicable: false,
    reason: "failure-anchor",
  });
  assert.deepEqual(analyzeGoTestOutput(composite), {
    applicable: false,
    reason: "composite-output",
  });
  assert.deepEqual(
    analyzeGoTestOutput(
      "=== RUN   TestOne\n--- PASS: TestOne (0.00s)\nok example/internal/one unexpected\n",
    ),
    { applicable: false, reason: "malformed-package-summary" },
  );
  assert.deepEqual(analyzeGoTestOutput("ordinary shell output\n"), {
    applicable: false,
    reason: "no-go-package-region",
  });
  assert.equal(isGoTestReplacementSmaller("small", "larger"), false);
});
