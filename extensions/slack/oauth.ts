import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Workspace } from "./workspaces.ts";

export const REDIRECT_URI = "http://localhost:34119/slack/callback";

export function authorizationUrl(
  clientId: string,
  scopes: string[],
  state: string,
  verifier: string,
): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.search = new URLSearchParams({
    client_id: clientId,
    user_scope: scopes.join(","),
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function exchangeCode(
  clientId: string,
  code: string,
  verifier: string,
  fetcher: typeof fetch = fetch,
): Promise<Workspace> {
  const response = await fetcher("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const result = (await response.json()) as any;
  if (
    !response.ok ||
    !result.ok ||
    !result.team?.id ||
    !result.authed_user?.id ||
    !result.authed_user?.access_token
  )
    throw new Error(
      "Slack authorization failed. Check app settings and try again.",
    );
  const user = result.authed_user;
  return {
    teamId: result.team.id,
    name: result.team.name || result.team.id,
    userId: user.id,
    clientId,
    accessToken: user.access_token,
    scopes: user.scope || "",
    ...(user.refresh_token ? { refreshToken: user.refresh_token } : {}),
    ...(user.expires_in
      ? { expiresAt: Date.now() + user.expires_in * 1000 }
      : {}),
  };
}

export async function authorize(
  clientId: string,
  scopes: string[],
  open: (url: string) => Promise<void>,
): Promise<Workspace> {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", REDIRECT_URI);
    if (req.method !== "GET" || url.pathname !== "/slack/callback") {
      res.writeHead(404).end();
      return;
    }
    const supplied = Buffer.from(url.searchParams.get("state") || "");
    const expected = Buffer.from(state);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res.writeHead(400).end("Invalid authorization state.");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400).end("Authorization was not completed. Return to Pi.");
      rejectCode(new Error("Slack authorization was not completed."));
      return;
    }
    res
      .writeHead(200, {
        "content-type": "text/plain",
        "cache-control": "no-store",
      })
      .end("Slack authorization received. Return to Pi.");
    resolveCode(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(34119, "localhost", () => resolve());
  });
  const timeout = setTimeout(
    () => rejectCode(new Error("Slack authorization timed out.")),
    180_000,
  );
  try {
    await open(authorizationUrl(clientId, scopes, state, verifier));
    const code = await codePromise;
    return await exchangeCode(clientId, code, verifier);
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}
