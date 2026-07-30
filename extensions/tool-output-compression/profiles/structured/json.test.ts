import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  analyzeJsonOutput,
  findLineBoundedJsonRegions,
  isJsonReplacementSmaller,
  JSON_PROFILE_ID,
  JSON_REFERENCE_ID_PLACEHOLDER,
  jsonProfile,
  mayContainJsonOutput,
  renderJsonProfile,
} from "./json.ts";

const fixture = (name: string) =>
  readFile(
    fileURLToPath(new URL(`./fixtures/json/${name}`, import.meta.url)),
    "utf8",
  );

test("losslessly minifies standalone JSON without normalizing tokens", async () => {
  const [formatted, duplicateKeys, array, deepNesting] = await Promise.all([
    fixture("formatted-object.txt"),
    fixture("duplicate-keys.txt"),
    fixture("array.txt"),
    fixture("deep-nesting.txt"),
  ]);

  const formattedAnalysis = analyzeJsonOutput(formatted);
  assert.equal(formattedAnalysis.applicable, true);
  if (!formattedAnalysis.applicable) return;
  assert.equal(formattedAnalysis.profile.kind, "json");
  assert.equal(
    formattedAnalysis.profile.compactContent,
    String.raw`{"id":42,"message":"hello world","escaped":"quote: \"; slash: \\; newline: \n; unicode-space: \u0020","number":1.00,"negativeZero":-0,"scientific":1e+3,"unicode":"café"}`,
  );
  assert.match(formattedAnalysis.profile.compactContent, /1\.00/);
  assert.match(formattedAnalysis.profile.compactContent, /1e\+3/);
  assert.match(formattedAnalysis.profile.compactContent, /\\u0020/);

  const duplicateAnalysis = analyzeJsonOutput(duplicateKeys);
  assert.equal(duplicateAnalysis.applicable, true);
  if (!duplicateAnalysis.applicable) return;
  assert.equal(
    duplicateAnalysis.profile.compactContent,
    '{"first":1,"first":2,"nested":{"values":[0,1.00,-0]}}',
  );
  assert.equal(
    duplicateAnalysis.profile.compactContent.match(/"first"/g)?.length,
    2,
  );

  for (const content of [array, deepNesting]) {
    const analysis = analyzeJsonOutput(content);
    assert.equal(analysis.applicable, true);
    if (analysis.applicable) assert.equal(analysis.profile.kind, "json");
  }
});

test("keeps UTF-8 string bytes intact while removing external whitespace", () => {
  const analysis = analyzeJsonOutput(
    '{\n  "emoji": "😀",\n  "message": "café déjà vu"\n}\n',
  );
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;
  assert.equal(
    analysis.profile.compactContent,
    '{"emoji":"😀","message":"café déjà vu"}',
  );
  assert.equal(JSON.parse(analysis.profile.compactContent).emoji, "😀");
});

test("minifies JSONL records while retaining record separators", async () => {
  const raw = await fixture("records.jsonl");
  const analysis = analyzeJsonOutput(raw);
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;

  assert.equal(analysis.profile.kind, "jsonl");
  assert.equal(analysis.profile.regions.length, 3);
  assert.equal(
    analysis.profile.compactContent,
    String.raw`{"id":1,"message":"first record"}
[2,3,{"nested":true}]
{"id":3,"escaped":"\u0020 stays escaped"}`,
  );
});

test("minifies every independently bounded embedded region in source order", async () => {
  const [single, multiple, wrapped] = await Promise.all([
    fixture("embedded-single.txt"),
    fixture("embedded-multiple.txt"),
    fixture("wrapped-output.txt"),
  ]);

  const singleAnalysis = analyzeJsonOutput(single);
  assert.equal(singleAnalysis.applicable, true);
  if (!singleAnalysis.applicable) return;
  assert.equal(singleAnalysis.profile.kind, "embedded");
  assert.equal(singleAnalysis.profile.regions.length, 1);
  assert.equal(
    singleAnalysis.profile.compactContent,
    'request completed\n{"id":42,"status":"ok"}\nnext command follows\n',
  );

  const wrappedAnalysis = analyzeJsonOutput(wrapped);
  assert.equal(wrappedAnalysis.applicable, true);
  if (!wrappedAnalysis.applicable) return;
  assert.equal(wrappedAnalysis.profile.kind, "embedded");
  assert.equal(
    wrappedAnalysis.profile.compactContent,
    'command completed\n{"id":42}\n',
  );

  const multipleAnalysis = analyzeJsonOutput(multiple);
  assert.equal(multipleAnalysis.applicable, true);
  if (!multipleAnalysis.applicable) return;
  assert.equal(multipleAnalysis.profile.kind, "embedded");
  assert.equal(multipleAnalysis.profile.regions.length, 2);
  assert.equal(
    multipleAnalysis.profile.compactContent,
    'first payload:\n{"id":1,"state":"ready"}\nprogress: 50%\n[{"id":2},{"id":3}]\nfinished\n',
  );
});

test("rejects malformed, primitive, and ambiguous JSON-shaped output", async () => {
  const rejected = await Promise.all(
    ["commented.txt", "primitive.txt", "malformed.txt"].map(fixture),
  );

  for (const content of rejected) {
    assert.deepEqual(analyzeJsonOutput(content), {
      applicable: false,
      reason: "no-json-output",
    });
  }

  const [blankRecords, mixedRecords] = await Promise.all([
    fixture("blank-record.jsonl"),
    fixture("mixed-records.jsonl"),
  ]);
  const blankAnalysis = analyzeJsonOutput(blankRecords);
  assert.equal(blankAnalysis.applicable, true);
  if (blankAnalysis.applicable) {
    assert.equal(blankAnalysis.profile.kind, "embedded");
    assert.equal(blankAnalysis.profile.regions.length, 2);
  }
  const mixedAnalysis = analyzeJsonOutput(mixedRecords);
  assert.equal(mixedAnalysis.applicable, true);
  if (mixedAnalysis.applicable) {
    assert.equal(mixedAnalysis.profile.kind, "embedded");
    assert.equal(mixedAnalysis.profile.regions.length, 1);
    assert.equal(mixedAnalysis.profile.compactContent, '{"id":1}\n42\n');
  }

  assert.deepEqual(analyzeJsonOutput('label { "id": 42 }\n'), {
    applicable: false,
    reason: "no-json-output",
  });
  assert.deepEqual(analyzeJsonOutput('{ "id": 42 } trailing text\n'), {
    applicable: false,
    reason: "no-json-output",
  });
  assert.deepEqual(analyzeJsonOutput("ordinary shell output\n"), {
    applicable: false,
    reason: "no-json-output",
  });
});

test("adapts JSON analysis to the generic profile contract", async () => {
  const raw = await fixture("embedded-multiple.txt");
  assert.equal(JSON_PROFILE_ID, "json");
  assert.equal(jsonProfile.mayMatch(raw), true);
  assert.equal(mayContainJsonOutput("ordinary shell output"), false);

  const analysis = jsonProfile.analyze(raw);
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;
  assert.deepEqual(analysis.summary, {
    jsonValues: 2,
    embeddedValues: 2,
    jsonlValues: 0,
  });

  const rendered = analysis.render(JSON_REFERENCE_ID_PLACEHOLDER);
  assert.match(rendered, /first payload:\n\{"id":1,"state":"ready"}/);
  assert.match(rendered, /Original JSON output available/);
});

test("uses an output-level retrieval marker and never-worse byte gate", async () => {
  const raw = await fixture("embedded-single.txt");
  const analysis = analyzeJsonOutput(raw);
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;

  const rendered = renderJsonProfile(analysis.profile, "reference-id");
  assert.match(
    rendered,
    /next command follows\n\[Original JSON output available/,
  );
  assert.match(rendered, /id: "reference-id"/);
  assert.equal(isJsonReplacementSmaller("small", "larger"), false);
  assert.equal(isJsonReplacementSmaller(raw, rendered), false);
});

test("uses a UTF-8-safe incomplete minified tail only for recovered full output", () => {
  const raw = [
    "{",
    '  "items": [',
    ...Array.from(
      { length: 30 },
      (_, index) => `    { "index": ${index}, "emoji": "🌍" },`,
    ),
    '    { "index": 30, "emoji": "🌍" }',
    "  ]",
    "}",
  ].join("\n");
  const analysis = analyzeJsonOutput(raw);
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;

  const visibleBytes = 300;
  const rendered = renderJsonProfile(analysis.profile, "reference-id", {
    visibleBytes,
    rawSource: "full-output-path",
  });
  assert.match(rendered, /Minified JSON tail; original output is incomplete/);
  assert.doesNotMatch(rendered, /�/);
  assert.ok(Buffer.byteLength(rendered, "utf8") < visibleBytes);

  const visibleRender = renderJsonProfile(analysis.profile, "reference-id", {
    visibleBytes,
    rawSource: "visible",
  });
  assert.match(visibleRender, /Original JSON output available/);
});

test("aligns a recovered JSONL tail to a complete record boundary", () => {
  const raw = Array.from(
    { length: 30 },
    (_, index) => `{ "record": ${index}, "emoji": "🌍" }`,
  ).join("\n");
  const analysis = analyzeJsonOutput(raw);
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;
  assert.equal(analysis.profile.kind, "jsonl");

  const rendered = renderJsonProfile(analysis.profile, "reference-id", {
    visibleBytes: 300,
    rawSource: "full-output-path",
  });
  const tail = rendered.slice(rendered.indexOf("\n") + 1);
  assert.match(tail, /^\{"record":\d+,"emoji":"🌍"\}/);
  assert.doesNotMatch(tail, /�/);
});

test("finds nonoverlapping line-bounded regions without selecting nested values", () => {
  const content = [
    "prefix",
    "{",
    '  "outer": { "nested": [ 1, 2 ] }',
    "}",
    "between",
    "[ 3, 4 ]",
    "suffix",
  ].join("\n");
  const regions = findLineBoundedJsonRegions(content);
  assert.equal(regions.length, 2);
  assert.equal(
    content.slice(regions[0]!.start, regions[0]!.end).startsWith("{"),
    true,
  );
  assert.equal(content.slice(regions[1]!.start, regions[1]!.end), "[ 3, 4 ]");
});
