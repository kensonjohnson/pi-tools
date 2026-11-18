import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFile, fileInfo } from "./files.ts";
import type { Workspace } from "./workspaces.ts";

const workspace: Workspace = {
  teamId: "T1",
  name: "First",
  userId: "U1",
  clientId: "1.2",
  accessToken: "sensitive",
  scopes: "files:read",
};
const file = {
  id: "F1",
  name: "notes.txt",
  mimetype: "text/plain",
  url_private_download: "https://files.slack.com/files-pri/x/file",
};

function mock(info: object, response = new Response("hello")) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher = async (url: any, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    return String(url).startsWith("https://slack.com/api/")
      ? new Response(JSON.stringify(info))
      : response;
  };
  return { requests, fetcher: fetcher as typeof fetch };
}

test("file metadata and download preserve bytes, no overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slack-file-"));
  try {
    const f = mock({ ok: true, file });
    const info = await fileInfo(workspace, "F1", f.fetcher);
    assert.equal(info.mimetype, "text/plain");
    const path = join(dir, "notes.txt");
    await downloadFile(workspace, "F1", path, f.fetcher);
    assert.equal(await readFile(path, "utf8"), "hello");
    assert.equal(f.requests[2].init.redirect, "manual");
    assert.equal(
      (f.requests[2].init.headers as any).Authorization,
      "Bearer sensitive",
    );
    await assert.rejects(
      downloadFile(workspace, "F1", path, f.fetcher),
      /EEXIST/,
    );
    assert.equal(await readFile(path, "utf8"), "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("external, hostile, redirected and denied files never leak credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slack-file-"));
  try {
    const path = join(dir, "out");
    for (const data of [
      { ...file, is_external: true },
      {
        ...file,
        url_private_download: "https://files.slack.com.attacker.test/file",
      },
    ]) {
      const f = mock({ ok: true, file: data });
      await assert.rejects(downloadFile(workspace, "F1", path, f.fetcher));
      assert.equal(f.requests.length, 1);
    }
    const redirect = mock(
      { ok: true, file },
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/" },
      }),
    );
    await assert.rejects(
      downloadFile(workspace, "F1", path, redirect.fetcher),
      /redirected/,
    );
    assert.equal(redirect.requests.length, 2);
    const denied = mock({ ok: false, error: "missing_scope" });
    await assert.rejects(
      fileInfo(workspace, "F1", denied.fetcher),
      /files:read/,
    );
    await writeFile(path, "available");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
