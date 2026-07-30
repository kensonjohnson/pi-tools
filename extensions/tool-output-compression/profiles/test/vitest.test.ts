import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  VITEST_REFERENCE_ID_PLACEHOLDER,
  analyzeVitestOutput,
  isVitestReplacementSmaller,
  renderVitestProfile,
  vitestProfile,
} from "./vitest.ts";

const fixture = (name: string) =>
  readFile(
    fileURLToPath(new URL(`./fixtures/vitest/${name}`, import.meta.url)),
    "utf8",
  );

test("summarizes a successful test-level Vitest run and preserves its preamble", async () => {
  const raw = await fixture("test-level-success.txt");
  const analysis = analyzeVitestOutput(raw);
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;

  assert.deepEqual(
    {
      passedTestFiles: analysis.profile.passedTestFiles,
      passedTests: analysis.profile.passedTests,
      passLines: analysis.profile.passLines,
      passVariant: analysis.profile.passVariant,
      duration: analysis.profile.duration,
    },
    {
      passedTestFiles: 2,
      passedTests: 3,
      passLines: 3,
      passVariant: "test",
      duration: "1.32s",
    },
  );
  const compact = renderVitestProfile(
    analysis.profile,
    VITEST_REFERENCE_ID_PLACEHOLDER,
  );
  assert.match(
    compact,
    /^pnpm vitest run\n\nVitest passed: 2 test files; 3 tests in 1\.32s\./,
  );
  assert.match(compact, /retrieve_tool_output/);
  assert.equal(isVitestReplacementSmaller(raw, compact), true);
});

test("summarizes a successful file-level Vitest run", async () => {
  const raw = await fixture("file-level-success.txt");
  const analysis = analyzeVitestOutput(raw);
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;

  assert.equal(analysis.profile.passVariant, "file");
  assert.equal(analysis.profile.passLines, 2);
  assert.equal(analysis.profile.passedTestFiles, 2);
  assert.equal(analysis.profile.passedTests, 3);
  assert.match(
    renderVitestProfile(analysis.profile, "id"),
    /Vitest passed: 2 test files; 3 tests in 1\.39s\./,
  );
});

test("adapts Vitest analysis to the generic profile contract", async () => {
  const raw = await fixture("file-level-success.txt");
  assert.equal(vitestProfile.id, "vitest");
  assert.equal(vitestProfile.settingPath, "test.vitest");
  assert.equal(vitestProfile.mayMatch(raw), true);
  const analysis = vitestProfile.analyze(raw);
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;
  assert.deepEqual(analysis.summary, {
    passedTestFiles: 2,
    passedTests: 3,
    passLines: 2,
  });
});

test("rejects malformed, mixed, failed, and composite Vitest output", async () => {
  const [failed, composite] = await Promise.all([
    fixture("failure-output.txt"),
    fixture("composite-output.txt"),
  ]);
  assert.deepEqual(analyzeVitestOutput(failed), {
    applicable: false,
    reason: "nonempty-suffix",
  });
  assert.deepEqual(analyzeVitestOutput(composite), {
    applicable: false,
    reason: "composite-output",
  });

  const valid = await fixture("file-level-success.txt");
  assert.deepEqual(
    analyzeVitestOutput(valid.replace("(1 test) 0ms", "(1 test) instant")),
    { applicable: false, reason: "malformed-pass-line" },
  );
  assert.deepEqual(
    analyzeVitestOutput(
      valid.replace(
        " ✓ src/math.test.ts (1 test) 0ms",
        " ✓ src/math.test.ts > math > adds values 0ms",
      ),
    ),
    { applicable: false, reason: "mixed-pass-variants" },
  );
  assert.deepEqual(
    analyzeVitestOutput(
      valid.replace("Test Files  2 passed (2)", "Test Files  2 passed (3)"),
    ),
    { applicable: false, reason: "mismatched-file-totals" },
  );
  assert.deepEqual(
    analyzeVitestOutput(
      valid.replace("Tests  3 passed (3)", "Tests  3 passed (2)"),
    ),
    { applicable: false, reason: "mismatched-test-totals" },
  );
  assert.deepEqual(
    analyzeVitestOutput(
      valid.replace(
        " ✓ src/math.test.ts (1 test) 0ms",
        "console.log unexpected test output",
      ),
    ),
    { applicable: false, reason: "unexpected-region-line" },
  );
  assert.deepEqual(
    analyzeVitestOutput(
      valid.replace(
        " ✓ src/auth.test.ts (2 tests) 18ms\n ✓ src/math.test.ts (1 test) 0ms",
        "",
      ),
    ),
    { applicable: false, reason: "no-pass-entries" },
  );
  assert.deepEqual(analyzeVitestOutput("ordinary shell output\n"), {
    applicable: false,
    reason: "no-vitest-region",
  });
  assert.equal(isVitestReplacementSmaller("small", "larger"), false);
});
