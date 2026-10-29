import { test } from "node:test";
import assert from "node:assert/strict";
import { formatResult, formatSessionList } from "./results.ts";

test("session listing stays valid and reports omitted sessions, tabs and URLs", () => {
  const sessions = Array.from({ length: 80 }, (_, i) => ({
    sessionId: `session-${i}`,
    purpose: "development" as const,
    headless: true,
    tabs: Array.from({ length: 12 }, (_, j) => ({
      tabId: `tab-${i}-${j}`,
      url: `http://example.test/${'😀"'.repeat(900)}`,
    })),
  }));
  const text = formatSessionList(sessions);
  assert.ok(Buffer.byteLength(text) <= 16000);
  const result = JSON.parse(text);
  assert.equal(
    result.sessions.length + result.omittedSessions,
    sessions.length,
  );
  const includedTabs = result.sessions.flatMap((session: any) => session.tabs);
  assert.equal(includedTabs.length + result.omittedTabs, 80 * 12);
  assert.equal(
    includedTabs.filter((tab: any) => tab.urlOmitted).length,
    result.omittedUrls,
  );
  assert.ok(result.omittedUrls > 0);
  assert.ok(result.omittedTabs > 0);
  assert.ok(
    includedTabs.every(
      (tab: any) =>
        typeof tab.tabId === "string" &&
        (typeof tab.url === "string" || (tab.url === null && tab.urlOmitted)),
    ),
  );
});

test("oversized navigation URLs are omitted without truncating JSON or target", () => {
  const value = {
    target: { sessionId: "s", tabId: "t" },
    url: "😀".repeat(9000),
  };
  const text = formatResult(value);
  assert.ok(Buffer.byteLength(text) <= 16000);
  assert.deepEqual(JSON.parse(text), {
    target: value.target,
    url: null,
    urlOmitted: true,
  });
  assert.deepEqual(JSON.parse(formatResult({ ok: true })), { ok: true });
});
