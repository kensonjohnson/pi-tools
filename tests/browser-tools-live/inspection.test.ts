import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../extensions/browser-tools/artifacts.ts";
import {
  inspectionOutput,
  chunkOutput,
} from "../../extensions/browser-tools/output.ts";
import { ManagedSessions } from "../../extensions/browser-tools/sessions.ts";

test("staged inspection reads the addressed main document and awaits eval without silent serialization", async () => {
  const sessions = new ManagedSessions({
    launch: ({ headless }) =>
      chromium.launch({ headless, channel: "chromium" }),
  });
  try {
    const first = await sessions.start({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    await sessions.navigate(
      `data:text/html,${encodeURIComponent('<!doctype html><input type="hidden" value="secret"><iframe srcdoc="<p>frame-only</p>"></iframe><p>main-only</p>')}`,
      first,
    );
    const second = await sessions.newTab(first.sessionId);
    await sessions.navigate("data:text/html,<p>second-only</p>", second);
    const html = await sessions.content(first);
    assert.match(html.html, /main-only/);
    assert.match(html.html, /secret/);
    assert.doesNotMatch(html.html, /second-only/);
    assert.deepEqual(html.target, first);
    assert.deepEqual(
      await sessions.evaluate('Promise.resolve("hé🙂")', first),
      { target: first, text: "hé🙂", representation: "string" },
    );
    assert.equal(
      (
        await sessions.evaluate(
          '({value: document.querySelector("input").value})',
          first,
        )
      ).text,
      '{"value":"secret"}',
    );
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "browser-live-artifact-")),
    );
    try {
      const store = new ArtifactStore({ root: join(parent, "artifacts") });
      const generated = await sessions.evaluate(
        '(() => { document.body.innerHTML = "<p>" + "é🙂".repeat(350000) + "</p>"; return document.body.textContent; })()',
        first,
      );
      const content = await sessions.content(first);
      for (const text of [generated.text, content.html]) {
        const result = JSON.parse(
          await inspectionOutput(store, "live", text, { scope: "main" }),
        );
        assert.equal(result.complete, false);
        let offset = 0,
          rebuilt = "";
        for (;;) {
          const chunk = JSON.parse(
            await chunkOutput(store, "live", result.artifact.id, offset, 65536),
          );
          rebuilt += chunk.text;
          if (chunk.nextOffset === null) break;
          offset = chunk.nextOffset;
        }
        assert.equal(rebuilt, text);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
    await assert.rejects(
      sessions.evaluate("({x: undefined})", first),
      /Unsupported eval result/,
    );
    await assert.rejects(
      sessions.evaluate("new Date()", first),
      /Unsupported eval result/,
    );
    await assert.rejects(
      sessions.evaluate(
        "(() => { const x = {}; x.self = x; return x; })()",
        first,
      ),
      /Circular eval result/,
    );
    await sessions.closeTab(first);
    await assert.rejects(sessions.content(first), /Tab unavailable/);
  } finally {
    await sessions.shutdown();
  }
});
