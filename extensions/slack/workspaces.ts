import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";

export interface Workspace {
  teamId: string;
  name: string;
  userId: string;
  clientId: string;
  accessToken: string;
  scopes: string;
  refreshToken?: string;
  expiresAt?: number;
}

export function workspaceFile(): string {
  return join(
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    "slack-workspaces.json",
  );
}

export async function readWorkspaces(
  path = workspaceFile(),
): Promise<Workspace[]> {
  try {
    const result = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(result)) throw new Error("Invalid Slack workspace file");
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeWorkspaces(
  workspaces: Workspace[],
  path = workspaceFile(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(workspaces, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function selectWorkspace(workspaces: Workspace[], query?: string): Workspace {
  if (!query && workspaces.length === 1) return workspaces[0];
  if (!query)
    throw new Error(
      workspaces.length
        ? "Specify a Slack workspace; multiple are connected."
        : "No Slack workspace is connected. Run /slack connect.",
    );
  const matches = workspaces.filter(
    (w) =>
      w.teamId.toLowerCase() === query.toLowerCase() ||
      w.name.toLowerCase() === query.toLowerCase(),
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "Workspace name is ambiguous; use its ID."
        : "Slack workspace not found.",
    );
  return matches[0];
}

export function resolveWorkspace(
  workspaces: Workspace[],
  query?: string,
): Workspace {
  const workspace = selectWorkspace(workspaces, query);
  if (workspace.expiresAt && workspace.expiresAt <= Date.now())
    throw new Error(
      "Slack authorization expired. Reconnect this workspace with /slack reconnect.",
    );
  return workspace;
}

// The separate SQLite database contains no credentials. Its write lock is shared
// across processes and released by SQLite if a process exits unexpectedly.
async function withWorkspaceLock<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(`${path}.lock`);
  db.pragma("busy_timeout = 0");
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        db.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (
          (error as { code?: string }).code !== "SQLITE_BUSY" ||
          Date.now() >= deadline
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await action();
    } finally {
      db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
}

// Connect and disconnect must mutate the latest contents under the same lock.
export async function updateWorkspaces(
  update: (workspaces: Workspace[]) => Workspace[],
  path = workspaceFile(),
): Promise<void> {
  await withWorkspaceLock(path, async () => {
    await writeWorkspaces(update(await readWorkspaces(path)), path);
  });
}

export async function getAuthorizedWorkspace(
  query?: string,
): Promise<Workspace> {
  const path = workspaceFile();
  return withWorkspaceLock(path, async () => {
    const workspaces = await readWorkspaces(path);
    const workspace = selectWorkspace(workspaces, query);
    if (!workspace.expiresAt || workspace.expiresAt > Date.now() + 60_000)
      return workspace;
    if (!workspace.refreshToken)
      throw new Error(
        "Slack authorization expired or is expiring. Reconnect this workspace with /slack reconnect.",
      );

    let result: any;
    try {
      const response = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(30_000),
        body: new URLSearchParams({
          client_id: workspace.clientId,
          grant_type: "refresh_token",
          refresh_token: workspace.refreshToken,
        }),
      });
      result = await response.json();
      if (!response.ok || !result.ok) throw new Error();
    } catch {
      throw new Error(
        "Slack token refresh failed. Reconnect this workspace with /slack reconnect.",
      );
    }
    const user =
      result.authed_user || (result.token_type === "user" ? result : undefined);
    if (
      !user ||
      typeof user.access_token !== "string" ||
      !user.access_token ||
      typeof user.refresh_token !== "string" ||
      !user.refresh_token ||
      typeof user.expires_in !== "number" ||
      !Number.isFinite(user.expires_in) ||
      user.expires_in <= 0
    )
      throw new Error(
        "Slack token refresh failed. Reconnect this workspace with /slack reconnect.",
      );
    const refreshed = {
      ...workspace,
      accessToken: user.access_token,
      refreshToken: user.refresh_token,
      expiresAt: Date.now() + user.expires_in * 1000,
    };
    workspaces[workspaces.indexOf(workspace)] = refreshed;
    await writeWorkspaces(workspaces, path);
    return refreshed;
  });
}
