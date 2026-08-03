import { spawn } from "node:child_process";

const MAX_RG_OUTPUT_BYTES = 1024 * 1024;
const FILE_BATCH_SIZE = 128;

export type LiteralTextMatch = {
  path: string;
  line: number;
  startColumn: number;
  endColumn: number;
};

export type LiteralTextSearchResult = {
  matches: LiteralTextMatch[];
  limited: boolean;
  unavailable?: string;
};

type RgMatch = {
  type: "match";
  data: {
    path: { text?: string };
    line_number: number;
    submatches: Array<{ start: number; end: number }>;
  };
};

/**
 * Runs an explicit transient fixed-string search over worker-approved paths.
 * ripgrep JSON records include matching line text, but it is parsed in memory
 * only to obtain range metadata; it is never returned or persisted.
 */
export async function searchLiteralText(options: {
  root: string;
  paths: string[];
  query: string;
  limit: number;
  signal?: AbortSignal;
}): Promise<LiteralTextSearchResult> {
  const matches: LiteralTextMatch[] = [];
  let limited = false;
  for (let index = 0; index < options.paths.length; index += FILE_BATCH_SIZE) {
    if (options.signal?.aborted) throw new Error("Request cancelled");
    const batch = options.paths.slice(index, index + FILE_BATCH_SIZE);
    const result = await searchBatch({ ...options, paths: batch, matches });
    if (result.unavailable)
      return { matches, limited, unavailable: result.unavailable };
    limited ||= result.limited;
    if (matches.length >= options.limit || limited) break;
  }
  return { matches, limited };
}

async function searchBatch(options: {
  root: string;
  paths: string[];
  query: string;
  limit: number;
  matches: LiteralTextMatch[];
  signal?: AbortSignal;
}): Promise<{ limited: boolean; unavailable?: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      "rg",
      ["--json", "--fixed-strings", "--", options.query, ...options.paths],
      { cwd: options.root, stdio: ["ignore", "pipe", "ignore"] },
    );
    let pending = "";
    let outputBytes = 0;
    let limited = false;
    let spawnError: Error | undefined;
    const stop = () => {
      limited = true;
      child.kill();
    };
    const abort = () => {
      child.kill();
      reject(new Error("Request cancelled"));
    };
    if (options.signal?.aborted) return abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_RG_OUTPUT_BYTES) return stop();
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        let record: RgMatch | undefined;
        try {
          record = JSON.parse(line) as RgMatch;
        } catch {
          continue;
        }
        if (record.type !== "match" || !record.data.path.text) continue;
        for (const submatch of record.data.submatches) {
          options.matches.push({
            path: record.data.path.text,
            line: record.data.line_number,
            startColumn: submatch.start + 1,
            endColumn: submatch.end + 1,
          });
          if (options.matches.length >= options.limit) return stop();
        }
      }
    });
    child.once("close", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (spawnError) {
        resolveResult({ unavailable: spawnError.message, limited: false });
      } else if (code === 0 || code === 1 || limited) {
        resolveResult({ limited });
      } else {
        resolveResult({
          limited,
          unavailable: `rg exited with status ${code ?? "unknown"}.`,
        });
      }
    });
  });
}
