import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAuthorizedWorkspace,
  readWorkspaces,
  updateWorkspaces,
  writeWorkspaces,
  type Workspace,
} from "./workspaces.ts";

const workspace: Workspace = {
  teamId: "T1",
  name: "One",
  userId: "U1",
  clientId: "client",
  accessToken: "old-access",
  refreshToken: "old-refresh",
  scopes: "search:read",
  expiresAt: 1,
};

test("refresh rotates credentials once, persists them and isolates workspaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slack-refresh-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  const other = {
    ...workspace,
    teamId: "T2",
    name: "Two",
    accessToken: "other",
    expiresAt: Date.now() + 3_600_000,
  };
  try {
    await writeWorkspaces([workspace, other]);
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, "https://slack.com/api/oauth.v2.access");
      const body = options?.body as URLSearchParams;
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "old-refresh");
      assert.equal(body.get("client_id"), "client");
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({
        ok: true,
        token_type: "user",
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      });
    };
    const [a, b] = await Promise.all([
      getAuthorizedWorkspace("T1"),
      getAuthorizedWorkspace("One"),
    ]);
    assert.equal(calls, 1);
    assert.equal(a.accessToken, "new-access");
    assert.deepEqual(a, b);
    const saved = await readWorkspaces();
    assert.equal(saved[0].refreshToken, "new-refresh");
    assert.deepEqual(saved[1], other);
    assert.equal(
      (await stat(join(dir, "slack-workspaces.json"))).mode & 0o777,
      0o600,
    );
    assert.equal((await getAuthorizedWorkspace("T2")).accessToken, "other");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test("separate processes share the refresh lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slack-refresh-process-"));
  const path = join(dir, "slack-workspaces.json");
  try {
    await writeWorkspaces([workspace], path);
    const script = `
      import { appendFile } from 'node:fs/promises';
      import { getAuthorizedWorkspace } from ${JSON.stringify(new URL("./workspaces.ts", import.meta.url).href)};
      globalThis.fetch = async () => {
        await appendFile(${JSON.stringify(join(dir, "calls"))}, 'call\\n');
        await new Promise(r => setTimeout(r, 150));
        return Response.json({ ok: true, token_type: 'user', access_token: 'new', refresh_token: 'next', expires_in: 3600 });
      };
      if ((await getAuthorizedWorkspace()).refreshToken !== 'next') process.exit(1);
    `;
    const run = () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", "--input-type=module", "-e", script],
          { env: { ...process.env, PI_CODING_AGENT_DIR: dir }, stdio: "pipe" },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(stderr)),
        );
      });
    await Promise.all([run(), run()]);
    assert.equal(await readFile(join(dir, "calls"), "utf8"), "call\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refresh failure hides secrets and leaves credentials unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slack-refresh-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await writeWorkspaces([workspace]);
    globalThis.fetch = async () => {
      throw new Error("old-refresh");
    };
    await assert.rejects(
      getAuthorizedWorkspace(),
      (error: Error) =>
        !error.message.includes("old-refresh") &&
        /refresh failed/.test(error.message),
    );
    globalThis.fetch = async () =>
      Response.json({
        ok: true,
        token_type: "user",
        access_token: "new-access",
      });
    await assert.rejects(getAuthorizedWorkspace(), /refresh failed/);
    assert.deepEqual(await readWorkspaces(), [workspace]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test("disconnect waits for refresh and removes latest credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slack-refresh-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await writeWorkspaces([workspace]);
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = async () => {
      started();
      await pending;
      return Response.json({
        ok: true,
        token_type: "user",
        access_token: "new",
        refresh_token: "next",
        expires_in: 3600,
      });
    };
    const refresh = getAuthorizedWorkspace();
    await entered;
    const disconnect = updateWorkspaces((all) =>
      all.filter((w) => w.teamId !== "T1"),
    );
    release();
    await Promise.all([refresh, disconnect]);
    assert.deepEqual(await readWorkspaces(), []);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  }
});
