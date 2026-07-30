import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  analyzeSearchRecordsOutput,
  decodeSearchRecordBody,
  hasSearchCommandSegment,
  isSearchRecordReplacementSmaller,
  mayContainSearchRecords,
  mayContainSearchRecordRawProbe,
  renderSearchRecordBody,
  searchRecordSummary,
  searchRecordsProfile,
} from "./records.ts";

const fixture = (name: string) =>
  readFile(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    "utf8",
  );

const rgCommand = "rg -n --no-heading 'needle' src";

test("recognizes only safely lexed rg and grep command segments", () => {
  for (const command of [
    rgCommand,
    "MY_ENV=1 command /usr/bin/grep -n 'needle' src | sort",
    "cd project && grep -rn 'needle' .",
    "grep '$(literal text)' file.txt",
  ]) {
    assert.equal(hasSearchCommandSegment(command), true, command);
  }

  for (const command of [
    "echo rg",
    "git grep needle",
    "grep 'unfinished",
    'grep "$(printf needle)" file.txt',
    "grep ${pattern} file.txt",
    "grep needle > result.txt",
    "( grep needle file.txt )",
  ]) {
    assert.equal(hasSearchCommandSegment(command), false, command);
  }
});

test("renders standard rg records reversibly in source order", async () => {
  const raw = await fixture("standard-rg.txt");
  const analysis = analyzeSearchRecordsOutput(raw, rgCommand);
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;

  assert.deepEqual(searchRecordSummary(analysis.profile), {
    records: 4,
    prefixGroups: 2,
    factoredRecords: 3,
  });

  const body = renderSearchRecordBody(analysis.profile);
  assert.equal(
    body,
    [
      "• src/core.ts",
      "  7:needle in source",
      "  8:another needle",
      "  12:third needle",
      "• README.md",
      "  3:needle in documentation",
      "",
    ].join("\n"),
  );
  assert.equal(decodeSearchRecordBody(body), raw);
  assert.equal(isSearchRecordReplacementSmaller(raw, body), true);
});

test("preserves pipeline-added count prefixes as opaque text", async () => {
  const raw = await fixture("counted-pipeline.txt");
  const analysis = analyzeSearchRecordsOutput(
    raw,
    "grep -rn needle . | sort | uniq -c",
  );
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;

  const body = renderSearchRecordBody(analysis.profile);
  assert.match(body, /^•    1 docs/);
  assert.match(body, /  10:needle/);
  assert.equal(decodeSearchRecordBody(body), raw);
});

test("keeps noncontiguous prefixes separate and preserves UTF-8, CRLF, and no final newline", async () => {
  const raw = await fixture("noncontiguous.txt");
  const analysis = analyzeSearchRecordsOutput(raw, rgCommand);
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;
  assert.equal(analysis.profile.groups.length, 3);
  assert.deepEqual(
    analysis.profile.groups.map((group) => group.records.length),
    [2, 1, 1],
  );
  assert.equal(
    decodeSearchRecordBody(renderSearchRecordBody(analysis.profile)),
    raw,
  );

  const crlf = "src/é.ts:1:😀 needle\r\nsrc/é.ts:2:still 😀\r\n";
  const crlfAnalysis = analyzeSearchRecordsOutput(crlf, rgCommand);
  assert.equal(crlfAnalysis.applicable, true);
  if (crlfAnalysis.applicable) {
    assert.equal(
      decodeSearchRecordBody(renderSearchRecordBody(crlfAnalysis.profile)),
      crlf,
    );
  }

  const noFinalNewline = "src/a.ts:1:needle\nsrc/a.ts:2:needle";
  const noFinalAnalysis = analyzeSearchRecordsOutput(noFinalNewline, rgCommand);
  assert.equal(noFinalAnalysis.applicable, true);
  if (noFinalAnalysis.applicable) {
    assert.equal(
      decodeSearchRecordBody(renderSearchRecordBody(noFinalAnalysis.profile)),
      noFinalNewline,
    );
  }
});

test("adapts command evidence and bounded raw probes to the generic profile contract", async () => {
  const raw = await fixture("standard-rg.txt");
  assert.equal(
    searchRecordsProfile.mayMatch(raw, { bashCommand: rgCommand }),
    true,
  );
  assert.equal(
    searchRecordsProfile.mayMatch(raw, { bashCommand: "echo rg" }),
    false,
  );
  assert.equal(
    mayContainSearchRecordRawProbe(
      {
        byteLength: raw.length,
        head: Buffer.from("unrelated head"),
        tail: Buffer.from("src/core.ts:7:needle"),
      },
      rgCommand,
    ),
    true,
  );
  assert.equal(
    mayContainSearchRecordRawProbe(
      {
        byteLength: raw.length,
        head: Buffer.from("unrelated"),
        tail: Buffer.from("still unrelated"),
      },
      rgCommand,
    ),
    false,
  );

  const analysis = searchRecordsProfile.analyze(raw, {
    bashCommand: rgCommand,
  });
  assert.equal(analysis.applicable, true);
  if (!analysis.applicable) return;
  assert.deepEqual(analysis.summary, {
    records: 4,
    prefixGroups: 2,
    factoredRecords: 3,
  });
  assert.match(
    analysis.render("reference-id"),
    /Grouped exact search records[\s\S]*id: "reference-id"/,
  );
});

test("rejects uncertainty and unsupported record streams", async () => {
  const [ambiguous, prose, blank] = await Promise.all([
    fixture("ambiguous-delimiter.txt"),
    fixture("prose.txt"),
    fixture("blank-line.txt"),
  ]);

  assert.deepEqual(analyzeSearchRecordsOutput(ambiguous, rgCommand), {
    applicable: false,
    reason: "ambiguous-record",
  });
  assert.deepEqual(analyzeSearchRecordsOutput(prose, rgCommand), {
    applicable: false,
    reason: "non-record-line",
  });
  assert.deepEqual(analyzeSearchRecordsOutput(blank, rgCommand), {
    applicable: false,
    reason: "blank-line",
  });
  assert.deepEqual(analyzeSearchRecordsOutput("src/a.ts:1:needle", rgCommand), {
    applicable: false,
    reason: "no-repeated-prefix",
  });
  assert.deepEqual(
    analyzeSearchRecordsOutput(
      "src/a.ts:1:needle\nsrc/a.ts:2:needle",
      "echo rg",
    ),
    { applicable: false, reason: "no-search-command" },
  );
  assert.equal(
    analyzeSearchRecordsOutput(
      "src/a.ts:1:needle\nsrc/a.ts:2:needle\n",
      rgCommand,
    ).applicable,
    true,
  );
  assert.deepEqual(
    analyzeSearchRecordsOutput(
      "src/a.ts:1:needle\nsrc/a.ts:2:\u001b[31mneedle",
      rgCommand,
    ),
    { applicable: false, reason: "terminal-control" },
  );
  assert.deepEqual(
    analyzeSearchRecordsOutput(
      "src/a.ts:1:needle\0\nsrc/a.ts:2:needle",
      rgCommand,
    ),
    { applicable: false, reason: "nul-byte" },
  );
  for (const content of [
    "src/a.ts-1-context\nsrc/a.ts:2:needle",
    "src/a.ts:1:8:needle",
    '{ "line": 1, "text": "needle" }',
  ]) {
    assert.equal(
      analyzeSearchRecordsOutput(content, rgCommand).applicable,
      false,
    );
  }

  assert.equal(mayContainSearchRecords("src/a.ts:1:needle", rgCommand), true);
  assert.equal(mayContainSearchRecords("src/a.ts:1:needle", "echo rg"), false);
});
