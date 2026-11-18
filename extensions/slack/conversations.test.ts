import assert from "node:assert/strict";
import test from "node:test";
import {
  getConversationHistory,
  getThreadReplies,
  parseMessageLink,
} from "./conversations.ts";

const workspace = {
  teamId: "T1",
  name: "Test",
  userId: "U1",
  clientId: "1",
  accessToken: "secret-token",
  scopes: "channels:history",
};

test("history forwards pagination and retains message metadata", async () => {
  const message = {
    ts: "123.456",
    thread_ts: "123.456",
    reply_count: 2,
    files: [{ id: "F1", url_private: "https://files.slack.com/f" }],
  };
  const fetch = (async (url, init) => {
    const request = new URL(String(url));
    assert.equal(request.pathname, "/api/conversations.history");
    assert.equal(request.searchParams.get("channel"), "C123");
    assert.equal(request.searchParams.get("cursor"), "next=cursor");
    assert.equal(request.searchParams.get("limit"), "20");
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer secret-token",
    );
    return Response.json({
      ok: true,
      messages: [message],
      has_more: true,
      response_metadata: { next_cursor: "another" },
    });
  }) as typeof globalThis.fetch;
  assert.deepEqual(
    await getConversationHistory(workspace, "C123", {
      cursor: "next=cursor",
      limit: 20,
      fetch,
    }),
    {
      messages: [message],
      hasMore: true,
      nextCursor: "another",
    },
  );
});

test("thread links select parent timestamp and preserve continuation", async () => {
  const link =
    "https://example.slack.com/archives/C123/p1700000000123456?thread_ts=1699999999.123456&cid=C123";
  assert.deepEqual(parseMessageLink(link), {
    channel: "C123",
    ts: "1699999999.123456",
  });
  const fetch = (async (url) => {
    const request = new URL(String(url));
    assert.equal(request.pathname, "/api/conversations.replies");
    assert.equal(request.searchParams.get("ts"), "1699999999.123456");
    return Response.json({
      ok: true,
      messages: [{ ts: "1.1" }],
      response_metadata: { next_cursor: "cursor" },
    });
  }) as typeof globalThis.fetch;
  const result = await getThreadReplies(workspace, link, undefined, { fetch });
  assert.equal(result.hasMore, true);
  assert.equal(result.nextCursor, "cursor");
  assert.throws(
    () => parseMessageLink("https://evil.com/archives/C123/p1700000000123456"),
    /Invalid/,
  );
});

test("Slack errors are actionable without leaking credentials", async () => {
  const missingScope = (async () =>
    Response.json({
      ok: false,
      error: "missing_scope",
      detail: "secret-token",
    })) as typeof fetch;
  await assert.rejects(
    getConversationHistory(workspace, "C123", { fetch: missingScope }),
    /missing a required/,
  );
  const rateLimit = (async () =>
    new Response("secret-token", {
      status: 429,
      headers: { "retry-after": "30" },
    })) as typeof fetch;
  await assert.rejects(
    getConversationHistory(workspace, "C123", { fetch: rateLimit }),
    /Retry after 30 seconds/,
  );
  const failure = (async () => {
    throw new Error("secret-token");
  }) as typeof fetch;
  await assert.rejects(
    getConversationHistory(workspace, "C123", { fetch: failure }),
    (error: Error) => !error.message.includes("secret-token"),
  );
});
