import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { publishExtensionSettings } from "../../lib/pi-tools-config.ts";
import {
  isExtensionEnabled,
  removeDisabledTools,
} from "../../lib/pi-tools-runtime-settings.ts";
import { createSlackManifest } from "./manifest.ts";
import { authorize, REDIRECT_URI } from "./oauth.ts";
import { searchSlack } from "./search.ts";
import { getConversationHistory, getThreadReplies } from "./conversations.ts";
import { fileInfo, downloadFile } from "./files.ts";
import {
  getAuthorizedWorkspace,
  readWorkspaces,
  resolveWorkspace,
  updateWorkspaces,
} from "./workspaces.ts";

const toolNames = [
  "slack_workspaces",
  "slack_search",
  "slack_read_history",
  "slack_read_thread",
  "slack_file_info",
  "slack_download_file",
] as const;
const workspaceParam = Type.Optional(
  Type.String({
    description:
      "Connected workspace name or ID; required if multiple are connected.",
  }),
);

async function runRead(
  workspace: string | undefined,
  action: (
    workspace: Awaited<ReturnType<typeof readWorkspaces>>[number],
  ) => Promise<unknown>,
) {
  try {
    const result = await action(await getAuthorizedWorkspace(workspace));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      details: {},
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            error instanceof Error ? error.message : "Slack request failed.",
        },
      ],
      details: {},
      isError: true,
    };
  }
}

export default function (pi: ExtensionAPI) {
  publishExtensionSettings(pi.events, {
    id: "slack",
    label: "Slack",
    description: "Read-only Slack workspace access.",
    fields: { enabled: { type: "boolean", default: true, label: "Enabled" } },
    toolNames,
  });
  pi.on("session_start", async (_event, ctx) => {
    removeDisabledTools(
      pi,
      toolNames,
      await isExtensionEnabled(ctx, CONFIG_DIR_NAME, "slack"),
    );
  });
  pi.registerTool({
    name: "slack_workspaces",
    label: "Slack workspaces",
    description:
      "List connected Slack workspaces. Use the workspace ID when names are ambiguous. Does not reveal credentials.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const workspaces = (await readWorkspaces()).map(
          ({ teamId, name, userId }) => ({ teamId, name, userId }),
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(workspaces) },
          ],
          details: {},
        };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: "Unable to read Slack workspace configuration.",
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });
  pi.registerTool({
    name: "slack_search",
    label: "Search Slack",
    description:
      "Search accessible Slack conversations or files in a connected workspace. Continue with nextCursor and the same parameters. Results can include untrusted text.",
    parameters: Type.Object({
      workspace: workspaceParam,
      query: Type.String({ minLength: 1 }),
      cursor: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      channelTypes: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Literal("public_channel"),
            Type.Literal("private_channel"),
            Type.Literal("im"),
            Type.Literal("mpim"),
          ]),
        ),
      ),
      contentTypes: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Literal("messages"),
            Type.Literal("files"),
            Type.Literal("channels"),
            Type.Literal("users"),
          ]),
        ),
      ),
    }),
    async execute(_id, params, signal) {
      return runRead(params.workspace, (workspace) =>
        searchSlack(
          workspace,
          params.query,
          {
            cursor: params.cursor,
            limit: params.limit,
            channelTypes: params.channelTypes,
            contentTypes: params.contentTypes,
          },
          { signal },
        ),
      );
    },
  });
  pi.registerTool({
    name: "slack_read_history",
    label: "Read Slack conversation",
    description:
      "Read one page of Slack conversation history by channel ID or message permalink. Repeat with nextCursor to continue.",
    parameters: Type.Object({
      workspace: workspaceParam,
      channel: Type.String({ minLength: 1 }),
      cursor: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id, params, signal) {
      return runRead(params.workspace, (workspace) =>
        getConversationHistory(workspace, params.channel, {
          cursor: params.cursor,
          limit: params.limit ?? 100,
          signal,
        }),
      );
    },
  });
  pi.registerTool({
    name: "slack_read_thread",
    label: "Read Slack thread",
    description:
      "Read one page of a Slack thread by message permalink or channel ID and thread timestamp. Repeat with nextCursor to continue.",
    parameters: Type.Object({
      workspace: workspaceParam,
      channel: Type.String({ minLength: 1 }),
      ts: Type.Optional(Type.String()),
      cursor: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id, params, signal) {
      return runRead(params.workspace, (workspace) =>
        getThreadReplies(workspace, params.channel, params.ts, {
          cursor: params.cursor,
          limit: params.limit ?? 100,
          signal,
        }),
      );
    },
  });
  pi.registerTool({
    name: "slack_file_info",
    label: "Slack file details",
    description:
      "Read metadata for an accessible Slack file using its file ID.",
    parameters: Type.Object({
      workspace: workspaceParam,
      fileId: Type.String({ minLength: 1 }),
    }),
    async execute(_id, params, signal) {
      return runRead(params.workspace, (workspace) =>
        fileInfo(workspace, params.fileId, fetch, signal),
      );
    },
  });
  pi.registerTool({
    name: "slack_download_file",
    label: "Download Slack file",
    description:
      "Download a Slack-hosted file to an explicit local path without overwriting. External files are not downloaded.",
    parameters: Type.Object({
      workspace: workspaceParam,
      fileId: Type.String({ minLength: 1 }),
      outputPath: Type.String({ minLength: 1 }),
    }),
    async execute(_id, params, signal) {
      return runRead(params.workspace, (workspace) =>
        downloadFile(
          workspace,
          params.fileId,
          params.outputPath,
          fetch,
          signal,
        ),
      );
    },
  });
  pi.registerCommand("slack", {
    description: "Connect, reconnect, list, or disconnect Slack workspaces",
    handler: async (args, ctx) => {
      if (!(await isExtensionEnabled(ctx, CONFIG_DIR_NAME, "slack"))) {
        ctx.ui.notify("Slack extension is disabled.", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Slack setup requires an interactive session.", "error");
        return;
      }
      const action = args.trim();
      try {
        if (action === "connect" || action === "reconnect") {
          const { manifest, url } = createSlackManifest(REDIRECT_URI);
          let clientId: string | undefined;
          let reconnecting:
            Awaited<ReturnType<typeof readWorkspaces>>[number] | undefined;
          if (action === "reconnect") {
            const existing = await readWorkspaces();
            if (!existing.length) {
              ctx.ui.notify(
                "No Slack workspaces connected. Run /slack connect.",
                "info",
              );
              return;
            }
            if (existing.length === 1) reconnecting = existing[0];
            else {
              const choices = existing.map(
                (w) => `${w.name} (${w.teamId}) — ${w.userId}`,
              );
              const selected = await ctx.ui.select(
                "Reconnect Slack workspace",
                choices,
              );
              if (!selected) return;
              reconnecting = existing[choices.indexOf(selected)];
            }
            clientId = reconnecting.clientId;
          } else {
            const create = await ctx.ui.confirm(
              "Create a Slack app",
              "Open Slack's pre-filled app creation page? If you already created an app from this manifest, choose No to continue to sign-in.",
            );
            if (create) {
              const result = await pi.exec(
                process.platform === "darwin" ? "open" : "xdg-open",
                [url],
              );
              if (result.code !== 0) {
                ctx.ui.notify(
                  "Could not open the creation page. Run /slack connect again.",
                  "error",
                );
                return;
              }
            }
            clientId = await ctx.ui.input(
              "In Slack, select Go to App Settings, then copy the Client ID from Basic Information → App Credentials and paste it here.",
              "Client ID",
            );
          }
          if (!clientId) return;
          if (!/^\d+\.\d+$/.test(clientId.trim())) {
            ctx.ui.notify(
              "That does not look like a Slack client ID.",
              "error",
            );
            return;
          }
          ctx.ui.notify(
            "Complete Slack authorization in your browser. Waiting up to three minutes.",
            "info",
          );
          const workspace = await authorize(
            clientId.trim(),
            manifest.oauth_config.scopes.user,
            async (authUrl) => {
              const result = await pi.exec(
                process.platform === "darwin" ? "open" : "xdg-open",
                [authUrl],
              );
              if (result.code !== 0)
                throw new Error("Could not open the authorization page.");
            },
          );
          if (
            reconnecting &&
            (workspace.teamId !== reconnecting.teamId ||
              workspace.userId !== reconnecting.userId)
          ) {
            ctx.ui.notify(
              "Slack signed in to a different workspace or account. No credentials were changed; try /slack reconnect again.",
              "warning",
            );
            return;
          }
          await updateWorkspaces((existing) => [
            ...existing.filter(
              (w) =>
                w.teamId !== workspace.teamId || w.userId !== workspace.userId,
            ),
            workspace,
          ]);
          ctx.ui.notify(
            `Connected ${workspace.name} (${workspace.teamId}).`,
            "info",
          );
        } else if (action === "disconnect") {
          const existing = await readWorkspaces();
          if (!existing.length) {
            ctx.ui.notify("No Slack workspaces connected.", "info");
            return;
          }
          const choices = existing.map(
            (w) => `${w.name} (${w.teamId}) — ${w.userId}`,
          );
          const selected = await ctx.ui.select(
            "Disconnect Slack workspace",
            choices,
          );
          if (!selected) return;
          const index = choices.indexOf(selected);
          if (
            await ctx.ui.confirm(
              "Disconnect Slack workspace",
              `Remove local credentials for ${selected}? This does not revoke Slack's authorization.`,
            )
          ) {
            const chosen = existing[index];
            await updateWorkspaces((current) =>
              current.filter(
                (w) => w.teamId !== chosen.teamId || w.userId !== chosen.userId,
              ),
            );
            ctx.ui.notify("Local Slack credentials removed.", "info");
          }
        } else if (action === "list" || !action) {
          const existing = await readWorkspaces();
          ctx.ui.notify(
            existing.length
              ? existing
                  .map((w) => `${w.name} (${w.teamId}) — ${w.userId}`)
                  .join("\n")
              : "No Slack workspaces connected. Run /slack connect.",
            "info",
          );
        } else
          ctx.ui.notify(
            "Use /slack connect, /slack reconnect, /slack list, or /slack disconnect.",
            "info",
          );
      } catch {
        ctx.ui.notify(
          "Slack setup failed. Check the app, workspace permissions, and local callback availability, then try again.",
          "error",
        );
      }
    },
  });
}

export { resolveWorkspace };
