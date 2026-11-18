// Slack manifest and PKCE settings: https://docs.slack.dev/authentication/using-pkce/
// Share links: https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/#sharing
export function createSlackManifest(redirectUri: string) {
  const manifest = {
    display_information: {
      name: "Pi Slack Reader",
      description: "Search and read Slack messages and files",
    },
    oauth_config: {
      redirect_urls: [redirectUri],
      scopes: {
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
      },
      pkce_enabled: true,
    },
  };
  const url = new URL("https://api.slack.com/apps");
  url.searchParams.set("new_app", "1");
  url.searchParams.set("manifest_json", JSON.stringify(manifest));
  return { manifest, url: url.toString() };
}
