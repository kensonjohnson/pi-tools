/**
 * Brave Search Extension - Web search and content extraction
 *
 * Requires BRAVE_API_KEY environment variable.
 * Get an API key at https://brave.com/search/api/ (free tier: 2000 queries/month)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import * as turndownPluginGfm from "turndown-plugin-gfm";

// Suppress CSS parsing errors - jsdom's CSSOM parser doesn't support
// all modern CSS features (nested selectors, layer statements, etc.)
// but we don't need styles for content extraction
const virtualConsole = new VirtualConsole();
virtualConsole.on("error", () => {});
virtualConsole.on("warn", () => {});

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
  query?: {
    original?: string;
  };
}

interface SearchDetails {
  query?: string;
  results?: Record<string, unknown>[];
  resultCount?: number;
  contentCount?: number;
  [key: string]: unknown;
}

interface WebContentDetails {
  url?: string;
  title?: string;
  contentLength?: number;
  [key: string]: unknown;
}

function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  turndown.use(turndownPluginGfm.gfm);
  turndown.addRule("removeEmptyLinks", {
    filter: (node: { nodeName: string; textContent?: string | null }) =>
      node.nodeName === "A" && !node.textContent?.trim(),
    replacement: () => "",
  });
  return turndown
    .turndown(html)
    .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
    .replace(/ +/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchBraveResults(
  query: string,
  numResults: number,
  country: string,
  freshness: string | null,
  apiKey: string,
): Promise<{ results: BraveSearchResult[]; apiError?: string }> {
  const params = new URLSearchParams({
    q: query,
    count: Math.min(numResults, 20).toString(),
    country: country,
  });

  if (freshness) {
    params.append("freshness", freshness);
  }

  const url = `https://api.search.brave.com/res/v1/web/search?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      results: [],
      apiError: `HTTP ${response.status}: ${response.statusText}\n${errorText}`,
    };
  }

  const data = (await response.json()) as BraveSearchResponse;
  const results = data.web?.results ?? [];

  return { results: results.slice(0, numResults) };
}

async function fetchWebContent(url: string): Promise<{
  content: string;
  title?: string;
  apiError?: string;
}> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return {
        content: "",
        apiError: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url, virtualConsole });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (article?.content) {
      const markdown = htmlToMarkdown(article.content);
      return {
        content: markdown,
        title: article.title ?? undefined,
      };
    }

    // Fallback: extract main content
    const fallbackDoc = new JSDOM(html, { url, virtualConsole });
    const body = fallbackDoc.window.document;
    body
      .querySelectorAll("script, style, noscript, nav, header, footer, aside")
      .forEach((el: { remove: () => any }) => el.remove());

    const title = body.querySelector("title")?.textContent?.trim();
    const main =
      body.querySelector("main, article, [role='main'], .content, #content") ||
      body.body;

    const text = main?.innerHTML || "";
    if (text.trim().length > 100) {
      return {
        content: htmlToMarkdown(text),
        title: title,
      };
    }

    return {
      content: "",
      apiError: "Could not extract readable content from this page.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: "",
      apiError: `Error: ${message}`,
    };
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "brave_search",
    label: "Brave Search",
    description:
      "Search the web using Brave Search API. Returns search results with titles, URLs, and descriptions. Optionally fetches readable content from result pages.",
    promptSnippet: "Search the web for current information",
    promptGuidelines: [
      "Use this tool when the user asks about current events, recent information, or topics that may have changed since training data.",
      "Set fetch_content to true when you need detailed information from web pages, not just search snippets.",
      "Summarize key findings from search results rather than just listing URLs.",
      "Always cite sources with URLs when providing information from search results.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "The search query to execute",
      }),
      count: Type.Optional(
        Type.Number({
          description: "Number of results to return (1-20, default 5)",
          minimum: 1,
          maximum: 20,
        }),
      ),
      country: Type.Optional(
        Type.String({
          description: "Country code for results (default: US)",
        }),
      ),
      freshness: Type.Optional(
        Type.String({
          description:
            'Filter by time period: "pd" (day), "pw" (week), "pm" (month), "py" (year)',
        }),
      ),
      fetch_content: Type.Optional(
        Type.Boolean({
          description:
            "Fetch and extract readable content from result pages (slower but more detailed)",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const apiKey = process.env.BRAVE_API_KEY;
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "Error: BRAVE_API_KEY environment variable not set. Get an API key at https://brave.com/search/api/ (free tier: 2000 queries/month)",
            },
          ],
          isError: true,
          details: {},
        };
      }

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Cancelled" }],
          details: {} as SearchDetails,
        };
      }

      const query = params.query.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "Error: Empty search query" }],
          isError: true,
          details: {} as SearchDetails,
        };
      }

      const numResults = Math.min(Math.max(params.count ?? 5, 1), 20);
      const country = params.country ?? "US";
      const freshness = params.freshness ?? null;
      const fetchContent = params.fetch_content ?? false;

      const { results, apiError } = await fetchBraveResults(
        query,
        numResults,
        country,
        freshness,
        apiKey,
      );

      if (apiError) {
        return {
          content: [
            {
              type: "text",
              text: `Brave Search API error: ${apiError}`,
            },
          ],
          isError: true,
          details: {} as SearchDetails,
        };
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No results found for "${query}"`,
            },
          ],
          details: { query, results: [] } as SearchDetails,
        };
      }

      if (!fetchContent) {
        // Return search results only
        const formattedResults = results
          .map(
            (r, i) =>
              `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.description}`,
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `Search results for "${query}":\n\n${formattedResults}`,
            },
          ],
          details: {
            query,
            resultCount: results.length,
            results: results.map((r) => ({
              title: r.title,
              url: r.url,
              description: r.description,
            })),
          },
        };
      }

      // Fetch content from result pages
      const contents: {
        url: string;
        title: string;
        content: string;
        error?: string;
      }[] = [];

      for (const result of results.slice(0, 3)) {
        if (signal?.aborted) break;

        const { content, title, apiError } = await fetchWebContent(result.url);
        contents.push({
          url: result.url,
          title: title || result.title,
          content,
          error: apiError,
        });
      }

      const formattedResults = contents
        .map((c, i) => {
          if (c.error) {
            return `${i + 1}. **${c.title}**\n   URL: ${c.url}\n   Error fetching content: ${c.error}`;
          }
          const snippet = c.content.slice(0, 2000);
          const truncated =
            c.content.length > 2000 ? "\n   ... (truncated)" : "";
          return `${i + 1}. **${c.title}**\n   URL: ${c.url}\n\n${snippet}${truncated}`;
        })
        .join("\n\n---\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Search results with content for "${query}":\n\n${formattedResults}`,
          },
        ],
        details: {
          query,
          resultCount: results.length,
          contentCount: contents.filter((c) => !c.error).length,
          results: contents,
        },
      };
    },
  });

  pi.registerTool({
    name: "web_content",
    label: "Web Content",
    description:
      "Extract readable content from a webpage as markdown. Useful for reading articles, documentation, or any web page.",
    promptSnippet: "Extract readable content from a URL",
    promptGuidelines: [
      "Use this tool when you need to read the full content of a specific web page.",
      "Returns the article content as markdown, with fallback to main content area.",
    ],
    parameters: Type.Object({
      url: Type.String({
        description: "The URL to extract content from",
      }),
    }),

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Cancelled" }],
          details: {} as WebContentDetails,
        };
      }

      const url = params.url.trim();
      if (!url) {
        return {
          content: [{ type: "text", text: "Error: Empty URL" }],
          isError: true,
          details: {} as WebContentDetails,
        };
      }

      const { content, title, apiError } = await fetchWebContent(url);

      if (apiError) {
        return {
          content: [
            {
              type: "text",
              text: `Error extracting content: ${apiError}`,
            },
          ],
          isError: true,
          details: {} as WebContentDetails,
        };
      }

      const header = title ? `# ${title}\n\n` : "";
      return {
        content: [
          {
            type: "text",
            text: `${header}Source: ${url}\n\n${content}`,
          },
        ],
        details: {
          url,
          title,
          contentLength: content.length,
        } as WebContentDetails,
      };
    },
  });
}
