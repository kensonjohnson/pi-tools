import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";
import { readWorkspaces, writeWorkspaces } from "./workspaces.ts";

const one = {
  teamId: "T1",
  name: "One",
  userId: "U1",
  clientId: "1.2",
  accessToken: "old",
  refreshToken: "expired",
  scopes: "",
  expiresAt: 1,
};
const two = {
  ...one,
  teamId: "T2",
  name: "Two",
  clientId: "3.4",
  accessToken: "other",
};

test("reconnect uses saved app details and rejects a different Slack account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slack-reconnect-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = directory;
  let handler: any;
  let wrongAccount = true;
  let inputs = 0;
  const notices: string[] = [];
  const pi = {
    events: { on() {}, emit() {} },
    on() {},
    registerTool() {},
    registerCommand(_name: string, command: any) {
      handler = command.handler;
    },
    async exec(_command: string, [url]: string[]) {
      const auth = new URL(url);
      assert.equal(auth.searchParams.get("client_id"), "1.2");
      const callback = new URL(auth.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", auth.searchParams.get("state")!);
      callback.searchParams.set("code", "mock-code");
      assert.equal((await oldFetch(callback)).status, 200);
      return { code: 0 };
    },
  };
  const ctx = {
    cwd: directory,
    isProjectTrusted: () => false,
    hasUI: true,
    ui: {
      select: async (_title: string, choices: string[]) => choices[0],
      input: async () => {
        inputs++;
        return "";
      },
      notify: (message: string) => notices.push(message),
    },
  };
  try {
    await writeWorkspaces([one, two]);
    globalThis.fetch = (async () =>
      Response.json({
        ok: true,
        team: { id: wrongAccount ? "T2" : "T1", name: "One" },
        authed_user: { id: "U1", access_token: "new", scope: "" },
      })) as typeof fetch;
    extension(pi as any);
    await handler("reconnect", ctx);
    assert.deepEqual(await readWorkspaces(), [one, two]);
    assert(notices.some((n) => n.includes("different workspace or account")));
    wrongAccount = false;
    await handler("reconnect", ctx);
    const saved = await readWorkspaces();
    assert.equal(saved.find((w) => w.teamId === "T1")?.accessToken, "new");
    assert.equal(saved.find((w) => w.teamId === "T2")?.accessToken, "other");
    assert.equal(inputs, 0);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    await rm(directory, { recursive: true, force: true });
  }
});
