import type { SessionSummary } from "./sessions.ts";

const MAX_BYTES = 16_000;
const byteLength = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

/** Keep complete JSON records and make every omitted session, tab, or URL explicit. */
export function formatSessionList(sessions: SessionSummary[]): string {
  const output: {
    sessions: {
      sessionId: string;
      purpose: string;
      headless: boolean;
      tabs: { tabId: string; url: string | null; urlOmitted?: boolean }[];
    }[];
    omittedSessions: number;
    omittedTabs: number;
    omittedUrls: number;
  } = {
    sessions: [],
    omittedSessions: sessions.length,
    omittedTabs: sessions.reduce(
      (count, session) => count + session.tabs.length,
      0,
    ),
    omittedUrls: 0,
  };
  for (const session of sessions) {
    const entry = {
      sessionId: session.sessionId,
      purpose: session.purpose,
      headless: session.headless,
      tabs: [] as { tabId: string; url: string | null; urlOmitted?: boolean }[],
    };
    output.sessions.push(entry);
    output.omittedSessions--;
    if (byteLength(output) > MAX_BYTES) {
      output.sessions.pop();
      output.omittedSessions++;
      continue;
    }
    for (const tab of session.tabs) {
      const full = { tabId: tab.tabId, url: tab.url };
      entry.tabs.push(full);
      output.omittedTabs--;
      if (byteLength(output) <= MAX_BYTES) continue;
      entry.tabs.pop();
      const redacted = {
        tabId: tab.tabId,
        url: null,
        urlOmitted: true as const,
      };
      entry.tabs.push(redacted);
      output.omittedUrls++;
      if (byteLength(output) <= MAX_BYTES) continue;
      entry.tabs.pop();
      output.omittedUrls--;
      output.omittedTabs++;
    }
  }
  return JSON.stringify(output);
}

/** For non-list results, omit an oversized URL rather than cutting JSON or IDs. */
export function formatResult(value: unknown): string {
  if (byteLength(value) <= MAX_BYTES) return JSON.stringify(value);
  if (value && typeof value === "object" && "url" in value) {
    const reduced = { ...value, url: null, urlOmitted: true };
    if (byteLength(reduced) <= MAX_BYTES) return JSON.stringify(reduced);
  }
  return JSON.stringify({
    omitted: true,
    reason: "Result exceeded the 16000-byte output limit.",
  });
}
