import { open, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import type { Workspace } from "./workspaces.ts";

type SlackFile = {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  permalink?: string;
  mode?: string;
  is_external?: boolean;
  filetype?: string;
  url_private?: string;
  url_private_download?: string;
  external_url?: string;
};

function apiError(response: Response, result?: { error?: string }): Error {
  if (response.status === 429)
    return new Error(
      `Slack rate limit reached; retry after ${response.headers.get("retry-after") || "the specified delay"} seconds.`,
    );
  if (
    ["invalid_auth", "not_authed", "token_expired", "token_revoked"].includes(
      result?.error || "",
    )
  )
    return new Error(
      "Slack authorization is invalid or expired. Run /slack reconnect.",
    );
  if (result?.error === "missing_scope")
    return new Error(
      "Slack requires the files:read permission. Reauthorize the app.",
    );
  if (result?.error === "file_not_found" || result?.error === "access_denied")
    return new Error("Slack file not found or not accessible to this user.");
  return new Error(
    "Slack file request failed. Check workspace authorization and file access.",
  );
}

async function loadFile(
  workspace: Workspace,
  fileId: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<SlackFile> {
  const url = new URL("https://slack.com/api/files.info");
  url.searchParams.set("file", fileId);
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Authorization: `Bearer ${workspace.accessToken}` },
      redirect: "manual",
      signal,
    });
  } catch {
    throw new Error(
      signal?.aborted
        ? "Slack file request cancelled."
        : "Slack file request failed. Check your connection.",
    );
  }
  let data: { ok?: boolean; error?: string; file?: SlackFile };
  try {
    data = await response.json();
  } catch {
    throw apiError(response);
  }
  if (!response.ok || !data.ok || !data.file?.id)
    throw apiError(response, data);
  return data.file;
}

export async function fileInfo(
  workspace: Workspace,
  fileId: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const file = await loadFile(workspace, fileId, fetcher, signal);
  return {
    id: file.id,
    name: file.name,
    title: file.title,
    mimetype: file.mimetype,
    size: file.size,
    permalink: file.permalink,
    external:
      file.mode === "external" ||
      file.is_external === true ||
      file.filetype === "remote",
    externalUrl: file.external_url,
  };
}

export async function downloadFile(
  workspace: Workspace,
  fileId: string,
  outputPath: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const file = await loadFile(workspace, fileId, fetcher, signal);
  if (
    file.mode === "external" ||
    file.is_external ||
    file.filetype === "remote"
  )
    throw new Error(
      "This is an external file; Slack does not host its contents.",
    );
  let url: URL;
  try {
    url = new URL(file.url_private_download || file.url_private || "");
  } catch {
    throw new Error("Slack did not provide a usable file URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "files.slack.com" ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error("Slack returned an untrusted file URL; download refused.");
  const destination = resolve(outputPath);
  const handle = await open(destination, "wx", 0o600);
  let complete = false;
  try {
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { Authorization: `Bearer ${workspace.accessToken}` },
        redirect: "manual",
        signal,
      });
    } catch {
      throw new Error(
        signal?.aborted
          ? "Slack file download cancelled."
          : "Slack file download failed. Check your connection.",
      );
    }
    if (response.status >= 300 && response.status < 400)
      throw new Error(
        "Slack file download redirected; download refused to protect credentials.",
      );
    if (!response.ok || !response.body) throw apiError(response);
    await pipeline(
      Readable.fromWeb(response.body as any),
      handle.createWriteStream(),
      { signal },
    );
    complete = true;
  } finally {
    await handle.close();
    if (!complete) await unlink(destination);
  }
  return {
    path: destination,
    id: file.id,
    name: file.name,
    mimetype: file.mimetype,
    size: file.size,
  };
}
