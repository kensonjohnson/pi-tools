import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";
import { writeWorkspaces, workspaceFile } from "./workspaces.ts";

test("registered tools search, read thread and download in selected workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-slack-integration-"));
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = directory;
  const tools = new Map<string, any>();
  const pi = {
    events: { on() {}, emit() {} },
    on() {},
    registerCommand() {},
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
  };
  try {
    await writeWorkspaces(
      [
        {
          teamId: "T1",
          name: "One",
          userId: "U1",
          clientId: "1.1",
          accessToken: "token-one",
          scopes: "",
        },
        {
          teamId: "T2",
          name: "Two",
          userId: "U2",
          clientId: "2.2",
          accessToken: "token-two",
          scopes: "",
        },
      ],
      workspaceFile(),
    );
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      assert.equal((init?.headers as any).Authorization, "Bearer token-two");
      const url = String(input);
      if (url.endsWith("assistant.search.context"))
        return Response.json({
          ok: true,
          results: {
            messages: [
              {
                channel_id: "C2",
                message_ts: "1700000000.123456",
                content: "found",
                permalink:
                  "https://two.slack.com/archives/C2/p1700000000123456",
              },
            ],
          },
          response_metadata: { next_cursor: "" },
        });
      if (url.includes("conversations.replies"))
        return Response.json({
          ok: true,
          messages: [{ ts: "1700000000.123456", files: [{ id: "F2" }] }],
          response_metadata: { next_cursor: "" },
        });
      if (url.includes("files.info"))
        return Response.json({
          ok: true,
          file: {
            id: "F2",
            name: "file.txt",
            url_private: "https://files.slack.com/f",
          },
        });
      if (url === "https://files.slack.com/f") return new Response("contents");
      throw new Error("Unexpected URL");
    }) as typeof fetch;
    extension(pi as any);
    assert.deepEqual(
      [...tools.keys()],
      [
        "slack_workspaces",
        "slack_search",
        "slack_read_history",
        "slack_read_thread",
        "slack_file_info",
        "slack_download_file",
      ],
    );
    const call = (name: string, params: any) =>
      tools.get(name).execute("id", params, undefined);
    const ambiguous = await call("slack_search", { query: "find" });
    assert.equal(ambiguous.isError, true);
    const search = await call("slack_search", {
      workspace: "T2",
      query: "find",
    });
    assert.match(search.content[0].text, /"channel_id":"C2"/);
    const thread = await call("slack_read_thread", {
      workspace: "Two",
      channel: "C2",
      ts: "1700000000.123456",
    });
    assert.match(thread.content[0].text, /"id":"F2"/);
    const path = join(directory, "file.txt");
    const download = await call("slack_download_file", {
      workspace: "T2",
      fileId: "F2",
      outputPath: path,
    });
    assert.equal(download.isError, undefined);
    assert.equal(await readFile(path, "utf8"), "contents");
    assert(!JSON.stringify([search, thread, download]).includes("token-two"));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDir;
    await rm(directory, { recursive: true, force: true });
  }
});
