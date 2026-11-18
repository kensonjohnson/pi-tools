import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readWorkspaces,
  resolveWorkspace,
  writeWorkspaces,
} from "./workspaces.ts";
import {
  authorizationUrl,
  authorize,
  exchangeCode,
  REDIRECT_URI,
} from "./oauth.ts";

const a = {
  teamId: "T1",
  name: "One",
  userId: "U1",
  clientId: "1.2",
  accessToken: "secret1",
  scopes: "files:read",
};
const b = { ...a, teamId: "T2", name: "Two", accessToken: "secret2" };

test("workspace credentials persist privately and selection is explicit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-slack-"));
  try {
    const path = join(dir, "credentials.json");
    assert.deepEqual(await readWorkspaces(path), []);
    await writeWorkspaces([a, b], path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const entries = await readWorkspaces(path);
    assert.equal(resolveWorkspace(entries, "T2").accessToken, "secret2");
    assert.throws(() => resolveWorkspace(entries), /multiple/);
    assert.throws(
      () => resolveWorkspace([a, { ...b, name: "One" }], "One"),
      /ambiguous/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OAuth callback rejects incorrect state before accepting the right state", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url) === "https://slack.com/api/oauth.v2.access")
      return new Response(
        JSON.stringify({
          ok: true,
          team: { id: "T1", name: "One" },
          authed_user: { id: "U1", access_token: "secret" },
        }),
      );
    return original(url, init);
  }) as typeof fetch;
  try {
    const workspace = await authorize("1.2", ["files:read"], async (url) => {
      const state = new URL(url).searchParams.get("state");
      const bad = await original(`${REDIRECT_URI}?state=wrong&code=no`);
      assert.equal(bad.status, 400);
      const good = await original(`${REDIRECT_URI}?state=${state}&code=valid`);
      assert.equal(good.status, 200);
    });
    assert.equal(workspace.teamId, "T1");
  } finally {
    globalThis.fetch = original;
  }
});

test("OAuth requests user scopes and exchanges verifier without leaking secrets on error", async () => {
  const url = new URL(
    authorizationUrl("1.2", ["files:read"], "state", "verifier"),
  );
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(url.searchParams.get("user_scope"), "files:read");
  assert.equal(url.searchParams.get("scope"), null);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const mock = async (_url: any, init: any) => {
    assert.equal(init.body.get("code_verifier"), "verifier");
    return new Response(
      JSON.stringify({
        ok: true,
        team: { id: "T1", name: "One" },
        authed_user: { id: "U1", scope: "files:read", access_token: "secret" },
      }),
    );
  };
  assert.equal(
    (await exchangeCode("1.2", "code", "verifier", mock as typeof fetch))
      .teamId,
    "T1",
  );
  await assert.rejects(
    exchangeCode(
      "1.2",
      "code",
      "verifier",
      (async () =>
        new Response(
          JSON.stringify({ ok: false, error: "secret" }),
        )) as typeof fetch,
    ),
    (e: Error) => !e.message.includes("secret"),
  );
});
