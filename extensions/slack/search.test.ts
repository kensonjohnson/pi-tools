import assert from "node:assert/strict";
import test from "node:test";
import { searchSlack, SlackSearchError } from "./search.ts";

const workspace = {
  teamId: "T1",
  name: "Team",
  userId: "U1",
  clientId: "id",
  accessToken: "secret-token",
  scopes: "search:read.public",
};

test("search sends the selected user token and continues with Slack's cursor", async () => {
  const requests: any[] = [];
  const mock: typeof fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(String(init?.body)) });
    return Response.json({
      ok: true,
      results: {
        messages: [
          {
            team_id: "T1",
            channel_id: "C1",
            message_ts: "1.2",
            content: "hello",
            permalink: "https://example.slack.com/archives/C1/p12",
            ignored: "no",
          },
        ],
        files: [
          {
            file_id: "F1",
            title: "file",
            permalink: "https://example.slack.com/f/F1",
          },
        ],
      },
      response_metadata: {
        next_cursor: requests.length === 1 ? "opaque+/=" : "",
      },
    });
  };
  const first = await searchSlack(
    workspace,
    "hello",
    { contentTypes: ["messages", "files"], limit: 5 },
    { fetch: mock },
  );
  assert.equal(
    requests[0].url,
    "https://slack.com/api/assistant.search.context",
  );
  assert.equal(requests[0].init.headers.Authorization, "Bearer secret-token");
  assert.deepEqual(requests[0].body.channel_types, [
    "public_channel",
    "private_channel",
    "mpim",
    "im",
  ]);
  assert.deepEqual(requests[0].body.content_types, ["messages", "files"]);
  assert.equal(first.results.messages[0].channel_id, "C1");
  assert.equal(first.results.messages[0].message_ts, "1.2");
  assert.equal(first.results.files[0].file_id, "F1");
  assert.equal(JSON.stringify(first).includes("secret-token"), false);
  const next = await searchSlack(
    workspace,
    "hello",
    { cursor: first.nextCursor!, limit: 5 },
    { fetch: mock },
  );
  assert.equal(requests[1].body.cursor, "opaque+/=");
  assert.equal(next.nextCursor, null);
});

test("search bounds response content and validates limit", async () => {
  const mock: typeof fetch = async () =>
    Response.json({
      ok: true,
      results: {
        messages: Array.from({ length: 25 }, () => ({
          content: "x".repeat(13000),
        })),
      },
    });
  const result = await searchSlack(workspace, "query", {}, { fetch: mock });
  assert.equal(result.results.messages.length, 20);
  assert.match(
    result.results.messages[0].content!,
    /\[Truncated; read the thread for full content\.\]$/,
  );
  await assert.rejects(
    searchSlack(workspace, "q", { limit: 21 }, { fetch: mock }),
    /between 1 and 20/,
  );
});

test("scope, rate limit and transport errors are actionable and never echo secrets", async () => {
  const scoped: typeof fetch = async () =>
    Response.json({
      ok: false,
      error: "missing_scope",
      detail: "secret-token",
    });
  await assert.rejects(
    searchSlack(workspace, "q", {}, { fetch: scoped }),
    (e: SlackSearchError) =>
      e.code === "missing_scope" && !e.message.includes("secret-token"),
  );
  const limited: typeof fetch = async () =>
    new Response("secret-token", {
      status: 429,
      headers: { "Retry-After": "30" },
    });
  await assert.rejects(
    searchSlack(workspace, "q", {}, { fetch: limited }),
    (e: SlackSearchError) => e.code === "rate_limited" && e.retryAfter === 30,
  );
  const failed: typeof fetch = async () => {
    throw new Error("secret-token");
  };
  await assert.rejects(
    searchSlack(workspace, "q", {}, { fetch: failed }),
    (e: SlackSearchError) =>
      e.code === "network_error" && !e.message.includes("secret-token"),
  );
});
