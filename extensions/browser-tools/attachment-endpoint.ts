import { request } from "node:http";

/**
 * CDP is an administrative protocol. Only literal loopback addresses are
 * accepted: no DNS, aliases, TLS, credentials, fragments or redirects.
 * Discovery and the advertised WebSocket must use the same authority.
 */
export function validateAttachmentEndpoint(
  input: string,
  protocol: "http:" | "ws:",
): URL {
  if (typeof input !== "string" || input.length > 4096 || /[\s\\]/.test(input))
    throw new Error("Invalid attachment endpoint");
  // Check the original authority before URL normalizes alternative IPv4 forms.
  const match =
    /^(http|ws):\/\/(127\.0\.0\.1|\[::1\]):([0-9]{1,5})(?=\/|\?|#|$)/.exec(
      input,
    );
  if (!match || `${match[1]}:` !== protocol)
    throw new Error(
      "Attachment requires a literal loopback endpoint with an explicit port",
    );
  const port = Number(match[3]);
  if (port < 1 || port > 65535) throw new Error("Invalid attachment port");
  const url = new URL(input);
  if (url.username || url.password || url.hash)
    throw new Error("Invalid attachment endpoint");
  return url;
}

/** HTTP discovery is read-only, bounded, and never follows redirects. */
export async function discoverAttachmentEndpoint(
  input: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const base = validateAttachmentEndpoint(input, "http:");
  if (base.pathname !== "/" || base.search)
    throw new Error("Discovery endpoint must be an origin");
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new Error("Invalid discovery timeout");
  const signal = options.signal;
  if (signal?.aborted) throw new Error("Attachment discovery aborted");
  const text = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value!);
    };
    const req = request(
      {
        hostname: base.hostname.replace(/^\[|\]$/g, ""),
        port: base.port,
        path: "/json/version",
        method: "GET",
        headers: { host: base.host },
        agent: false,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          finish(
            new Error(
              "Attachment discovery rejected non-200 response or redirect",
            ),
          );
          return;
        }
        let length = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 65536) {
            res.destroy();
            finish(new Error("Attachment discovery response too large"));
          } else chunks.push(chunk);
        });
        res.on("end", () =>
          finish(undefined, Buffer.concat(chunks).toString("utf8")),
        );
        res.on("error", () =>
          finish(new Error("Attachment discovery response failed")),
        );
        res.on("aborted", () =>
          finish(new Error("Attachment discovery response interrupted")),
        );
      },
    );
    const abort = () => {
      req.destroy();
      finish(new Error("Attachment discovery aborted"));
    };
    const timer = setTimeout(() => {
      req.destroy();
      finish(new Error("Attachment discovery timed out"));
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    req.on("error", () =>
      finish(new Error("Attachment discovery connection failed")),
    );
    req.end();
  });
  let advertised: unknown;
  try {
    advertised = JSON.parse(text)?.webSocketDebuggerUrl;
  } catch {
    throw new Error("Invalid attachment discovery response");
  }
  if (typeof advertised !== "string")
    throw new Error("Missing attachment WebSocket endpoint");
  const ws = validateAttachmentEndpoint(advertised, "ws:");
  if (ws.host !== base.host)
    throw new Error(
      "Attachment WebSocket authority differs from discovery endpoint",
    );
  return ws.href;
}
