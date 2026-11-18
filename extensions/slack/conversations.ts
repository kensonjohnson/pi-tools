import type { Workspace } from "./workspaces.ts";

export interface ConversationOptions {
  cursor?: string;
  limit?: number;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export interface SlackMessage {
  ts: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  files?: unknown[];
  [key: string]: unknown;
}

export interface ConversationPage {
  messages: SlackMessage[];
  nextCursor?: string;
  hasMore: boolean;
}

/** Parse a Slack message permalink. The caller must select the matching workspace. */
export function parseMessageLink(link: string): {
  channel: string;
  ts: string;
} {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error("Invalid Slack message link.");
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com")) {
    throw new Error("Invalid Slack message link.");
  }
  const match = /^\/archives\/([A-Za-z0-9]+)\/p(\d{10})(\d{6})\/?$/.exec(
    url.pathname,
  );
  if (!match) throw new Error("Invalid Slack message link.");
  // A reply permalink can include the parent timestamp explicitly.
  const threadTs = url.searchParams.get("thread_ts");
  if (threadTs && !/^\d+\.\d+$/.test(threadTs))
    throw new Error("Invalid Slack message link.");
  return { channel: match[1], ts: threadTs || `${match[2]}.${match[3]}` };
}

function channelId(channelOrLink: string): string {
  if (channelOrLink.startsWith("https://"))
    return parseMessageLink(channelOrLink).channel;
  if (!/^[A-Za-z0-9]+$/.test(channelOrLink))
    throw new Error("Invalid Slack conversation ID or message link.");
  return channelOrLink;
}

async function page(
  workspace: Workspace,
  method: "conversations.history" | "conversations.replies",
  channel: string,
  ts: string | undefined,
  options: ConversationOptions,
): Promise<ConversationPage> {
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 1000)
  ) {
    throw new Error("Slack page limit must be an integer between 1 and 1000.");
  }
  const url = new URL(`https://slack.com/api/${method}`);
  url.searchParams.set("channel", channel);
  if (ts) url.searchParams.set("ts", ts);
  if (options.cursor) url.searchParams.set("cursor", options.cursor);
  if (options.limit !== undefined)
    url.searchParams.set("limit", String(options.limit));
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(url, {
      headers: { Authorization: `Bearer ${workspace.accessToken}` },
      signal: options.signal,
    });
  } catch {
    if (options.signal?.aborted) throw new Error("Slack request cancelled.");
    throw new Error(
      "Slack request failed. Check your connection and try again.",
    );
  }
  if (response.status === 429) {
    const retry = response.headers.get("retry-after");
    throw new Error(
      `Slack rate limit reached.${retry && /^\d+$/.test(retry) ? ` Retry after ${retry} seconds.` : " Try again later."}`,
    );
  }
  if (!response.ok)
    throw new Error(
      `Slack request failed (HTTP ${response.status}). Try again later.`,
    );
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new Error("Slack returned an invalid response.");
  }
  if (!data || data.ok !== true) {
    const error = data?.error;
    if (error === "missing_scope")
      throw new Error(
        "Slack authorization is missing a required conversation history scope. Reconnect the workspace with the required scope.",
      );
    if (
      error === "invalid_auth" ||
      error === "token_revoked" ||
      error === "account_inactive"
    )
      throw new Error(
        "Slack authorization is invalid or revoked. Reconnect this workspace with /slack connect.",
      );
    if (error === "channel_not_found" || error === "not_in_channel")
      throw new Error(
        "Slack conversation not found or inaccessible. Check the conversation and workspace access.",
      );
    if (error === "thread_not_found")
      throw new Error(
        "Slack thread not found. Check the message link or timestamp.",
      );
    throw new Error(
      "Slack could not retrieve the conversation. Check workspace access and try again.",
    );
  }
  if (!Array.isArray(data.messages))
    throw new Error("Slack returned an invalid conversation response.");
  const nextCursor =
    typeof data.response_metadata?.next_cursor === "string" &&
    data.response_metadata.next_cursor
      ? data.response_metadata.next_cursor
      : undefined;
  return {
    messages: data.messages,
    nextCursor,
    hasMore: Boolean(data.has_more || nextCursor),
  };
}

/** Retrieve one page of conversation history. */
export function getConversationHistory(
  workspace: Workspace,
  channelOrLink: string,
  options: ConversationOptions = {},
): Promise<ConversationPage> {
  return page(
    workspace,
    "conversations.history",
    channelId(channelOrLink),
    undefined,
    options,
  );
}

/** Retrieve one page of a thread, including its parent message. */
export function getThreadReplies(
  workspace: Workspace,
  channelOrLink: string,
  ts?: string,
  options: ConversationOptions = {},
): Promise<ConversationPage> {
  const link = channelOrLink.startsWith("https://")
    ? parseMessageLink(channelOrLink)
    : undefined;
  const threadTs = ts ?? link?.ts;
  if (!threadTs || !/^\d+\.\d+$/.test(threadTs))
    throw new Error("A valid Slack thread timestamp is required.");
  return page(
    workspace,
    "conversations.replies",
    link?.channel ?? channelId(channelOrLink),
    threadTs,
    options,
  );
}
