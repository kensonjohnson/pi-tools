import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

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

export function resolveWorkspace(
  workspaces: Workspace[],
  query?: string,
): Workspace {
  if (!query && workspaces.length === 1) {
    if (workspaces[0].expiresAt && workspaces[0].expiresAt <= Date.now())
      throw new Error(
        "Slack authorization expired. Reconnect this workspace with /slack connect.",
      );
    return workspaces[0];
  }
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
  if (matches[0].expiresAt && matches[0].expiresAt <= Date.now())
    throw new Error(
      "Slack authorization expired. Reconnect this workspace with /slack connect.",
    );
  return matches[0];
}
