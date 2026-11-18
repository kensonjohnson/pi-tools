import assert from "node:assert/strict";
import test from "node:test";
import { createSlackManifest } from "./manifest.ts";

test("creates a PKCE manifest with only read-only user scopes", () => {
  const redirectUri = "http://localhost:43123/callback?source=pi&value=a%20b";
  const { manifest, url } = createSlackManifest(redirectUri);
  assert.deepEqual(manifest.oauth_config.redirect_urls, [redirectUri]);
  assert.equal(manifest.oauth_config.pkce_enabled, true);
  assert.deepEqual(manifest.oauth_config.scopes, {
    user: [
      "search:read.public",
      "search:read.private",
      "search:read.im",
      "search:read.mpim",
      "search:read.files",
      "channels:read",
      "channels:history",
      "groups:read",
      "groups:history",
      "im:read",
      "im:history",
      "mpim:read",
      "mpim:history",
      "files:read",
    ],
  });
  const link = new URL(url);
  assert.equal(link.origin + link.pathname, "https://api.slack.com/apps");
  assert.equal(link.searchParams.get("new_app"), "1");
  assert.deepEqual(
    JSON.parse(link.searchParams.get("manifest_json")!),
    manifest,
  );
});
