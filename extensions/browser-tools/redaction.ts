/** Default presentation policy, not a general-purpose secret detector. */
const sensitiveHeader =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;
const credentialParameter =
  /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|secret|password|passwd|authorization|code|client[_-]?secret|session[_-]?(?:id|token)|jwt|signature|sig|x-amz-(?:signature|credential|security-token)|x-goog-(?:signature|credential))$/i;

export function isSensitiveHeader(name: string): boolean {
  return sensitiveHeader.test(name);
}

export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    // Opaque URLs can contain the entire document, local path, or embedded token.
    // Do not expose them in metadata; explicit page inspection remains available.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      if (
        url.protocol === "about:" &&
        !url.search &&
        !url.hash &&
        (url.pathname === "blank" || url.pathname === "srcdoc")
      )
        return `about:${url.pathname}`;
      return "[non-HTTP URL omitted]";
    }
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted]";
    for (const key of [...url.searchParams.keys()]) {
      if (credentialParameter.test(key))
        url.searchParams.set(key, "[redacted]");
    }
    // Fragments can contain credentials in OAuth redirects and are not sent in requests.
    if (url.hash) url.hash = "#[redacted]";
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}

export function sanitizeHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    if (/^set-cookie$/i.test(name)) {
      // Playwright joins multiple Set-Cookie fields with newlines. Only expose
      // cookie names and known valueless flags, never arbitrary attributes.
      out[name] = value
        .split(/[\r\n]+|,(?=\s*[^;,=\r\n]+=[^;,\r\n]*)/)
        .map((cookie) => {
          const parts = cookie.split(";");
          const eq = parts[0].indexOf("=");
          const key = eq < 0 ? "" : parts[0].slice(0, eq).trim();
          const name = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) ? key + "=" : "";
          const flags = parts
            .slice(1)
            .map((x) => x.trim())
            .filter((x) => /^(secure|httponly|partitioned)$/i.test(x));
          return name + "[redacted]" + flags.map((x) => "; " + x).join("");
        })
        .join("\n");
    } else if (/^cookie$/i.test(name)) {
      out[name] = value
        .split(/[;\r\n]+/)
        .map((part) => {
          const eq = part.indexOf("=");
          return eq < 0 ? "[redacted]" : part.slice(0, eq + 1) + "[redacted]";
        })
        .join(";");
    } else out[name] = isSensitiveHeader(name) ? "[redacted]" : value;
  }
  return out;
}
