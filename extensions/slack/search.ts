import type { Workspace } from "./workspaces.ts";

export interface SearchOptions {
  cursor?: string;
  limit?: number;
  channelTypes?: ("public_channel" | "private_channel" | "mpim" | "im")[];
  contentTypes?: ("messages" | "files" | "channels" | "users")[];
  sort?: "score" | "timestamp";
  sortDir?: "asc" | "desc";
  before?: number;
  after?: number;
}

export interface SearchItem {
  team_id?: string;
  channel_id?: string;
  channel_name?: string;
  message_ts?: string;
  author_user_id?: string;
  author_name?: string;
  is_author_bot?: boolean;
  file_id?: string;
  user_id?: string;
  name?: string;
  title?: string;
  content?: string;
  topic?: string;
  purpose?: string;
  permalink?: string;
  file_type?: string;
}

export interface SearchResult {
  workspace: { teamId: string; name: string };
  results: Record<"messages" | "files" | "channels" | "users", SearchItem[]>;
  nextCursor: string | null;
}

export class SlackSearchError extends Error {
  readonly code: string;
  readonly retryAfter?: number;

  constructor(message: string, code: string, retryAfter?: number) {
    super(message);
    this.name = "SlackSearchError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const itemFields = [
  "team_id",
  "channel_id",
  "channel_name",
  "message_ts",
  "author_user_id",
  "author_name",
  "file_id",
  "user_id",
  "name",
  "title",
  "content",
  "topic",
  "purpose",
  "permalink",
  "file_type",
] as const;
const resultTypes = ["messages", "files", "channels", "users"] as const;

/** Makes one interactive search request. Pass nextCursor back unchanged to continue. */
export async function searchSlack(
  workspace: Workspace,
  query: string,
  options: SearchOptions = {},
  dependencies: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<SearchResult> {
  if (!query.trim()) throw new Error("Slack search query must not be empty.");
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 20)
  )
    throw new Error("Slack search limit must be an integer between 1 and 20.");
  const body = {
    query,
    channel_types: options.channelTypes ?? [
      "public_channel",
      "private_channel",
      "mpim",
      "im",
    ],
    content_types: options.contentTypes ?? ["messages"],
    cursor: options.cursor,
    limit: options.limit ?? 20,
    sort: options.sort,
    sort_dir: options.sortDir,
    before: options.before,
    after: options.after,
  };
  let response: Response;
  try {
    response = await (dependencies.fetch ?? fetch)(
      "https://slack.com/api/assistant.search.context",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workspace.accessToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: dependencies.signal,
      },
    );
  } catch {
    if (dependencies.signal?.aborted)
      throw new SlackSearchError("Slack search was cancelled.", "cancelled");
    throw new SlackSearchError("Slack search request failed.", "network_error");
  }
  const retryValue = response.headers.get("retry-after");
  const retryAfter =
    retryValue && /^\d+$/.test(retryValue) ? Number(retryValue) : undefined;
  if (response.status === 429)
    throw new SlackSearchError(
      `Slack search rate limit reached.${retryAfter !== undefined ? ` Retry after ${retryAfter} seconds.` : " Try again later."}`,
      "rate_limited",
      retryAfter,
    );
  if (!response.ok)
    throw new SlackSearchError(
      `Slack search failed with HTTP ${response.status}.`,
      "http_error",
    );
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new SlackSearchError(
      "Slack search returned an invalid response.",
      "invalid_response",
    );
  }
  if (!data || data.ok !== true) {
    const code = data?.error;
    if (code === "missing_scope")
      throw new SlackSearchError(
        "Slack search lacks the required scopes for the requested content or conversations. Reconnect the workspace with the required permissions.",
        "missing_scope",
      );
    if (code === "rate_limited" || code === "ratelimited")
      throw new SlackSearchError(
        "Slack search rate limit reached. Retry after the indicated delay.",
        "rate_limited",
        retryAfter,
      );
    if (
      ["invalid_auth", "not_authed", "token_expired", "token_revoked"].includes(
        code,
      )
    )
      throw new SlackSearchError(
        "Slack authorization is invalid or expired. Reconnect the workspace.",
        "invalid_auth",
      );
    if (code === "invalid_cursor")
      throw new SlackSearchError(
        "Slack search cursor is invalid or expired. Start the search again.",
        "invalid_cursor",
      );
    throw new SlackSearchError(
      "Slack search failed. Check workspace access and search options.",
      "slack_error",
    );
  }
  if (
    !data.results ||
    typeof data.results !== "object" ||
    Array.isArray(data.results)
  )
    throw new SlackSearchError(
      "Slack search returned an invalid response.",
      "invalid_response",
    );
  const results = {} as SearchResult["results"];
  for (const type of resultTypes) {
    const entries = Array.isArray(data.results[type]) ? data.results[type] : [];
    results[type] = entries
      .slice(0, 20)
      .filter(
        (item: unknown) =>
          item && typeof item === "object" && !Array.isArray(item),
      )
      .map((item: any) => {
        const result: SearchItem = {};
        for (const field of itemFields)
          if (typeof item[field] === "string")
            result[field] =
              item[field].length > 12000
                ? `${item[field].slice(0, 12000)}\n[Truncated; read the thread for full content.]`
                : item[field];
        if (typeof item.is_author_bot === "boolean")
          result.is_author_bot = item.is_author_bot;
        return result;
      });
  }
  const cursor = data.response_metadata?.next_cursor;
  return {
    workspace: { teamId: workspace.teamId, name: workspace.name },
    results,
    nextCursor: typeof cursor === "string" && cursor ? cursor : null,
  };
}
