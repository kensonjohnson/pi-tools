# pi-tools

A [pi](https://github.com/badlogic/pi-mono) package.
Adds web search using Brave Search API and browser tooling via Chrome DevTools Protocol.

_**I use Mac, feel free to fork and tweak for Windows/Linux!**_

## Install

Install from GitHub so pi discovers extensions and skills automatically:

```bash
pi install https://github.com/kensonjohnson/pi-tools
```

Or install a local clone:

```bash
git clone https://github.com/kensonjohnson/pi-tools.git /your/repos/pi-tools
pi install /your/repos/pi-tools
```

Then restart pi (or run `/reload`).

## Extensions

### `brave-search`

Web search (`brave_search`) and content extraction (`web_content`) using the Brave Search API.

Requires `BRAVE_API_KEY` environment variable to be set.

### `browser-tools`

Interactive browser automation via Chrome DevTools Protocol.

Connects to Brave Browser on `localhost:9222`.

| Tool                 | Description                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_start`      | Launch Brave with remote debugging on `:9222`. Pass `profile: true` to copy your default Brave profile (cookies, logins, extensions). |
| `browser_stop`       | Kill the spawned Brave process                                                                                                        |
| `browser_navigate`   | Navigate to a URL (new tab or current tab)                                                                                            |
| `browser_eval`       | Execute JavaScript in the active tab                                                                                                  |
| `browser_screenshot` | Capture viewport or full page to a PNG                                                                                                |
| `browser_content`    | Return raw page HTML (un-truncated)                                                                                                   |
| `browser_cookies`    | List cookies for the current tab                                                                                                      |
| `browser_pick`       | Interactive element picker — click to select                                                                                          |

### `custom-stats-footer`

Replaces Pi's default footer with context usage and last/average response tokens per second. TPS is measured from each assistant response's stream start to finish and therefore excludes time spent executing tools; the average is weighted by response tokens and stream duration.

If you happen to be using a codex subscription, enable **Custom Stats Footer → codexQuota.enabled** in `/pi-tools` to see your remaining weekly quota. This uses your existing `openai-codex` ChatGPT subscription login, refreshes every five minutes, and stores its settings in the shared `~/.pi/agent/pi-tools.json` file.

The quota source is an undocumented ChatGPT endpoint, so the feature is best-effort. Access tokens and account identifiers are used only in memory and are never written or displayed by the extension.

### `tool-output-compression`

Observes configured text-only tool results and reports RTK-style estimated token savings in `/tool-output`. Token estimates use UTF-8 bytes ÷ 4 and are approximate.

- **observe** (default) never changes a result or persists raw output.
- **apply** stores the first eligible result in a private SQLite database, then replaces only a later byte-identical result from the same session when a compact retrieval reference is smaller.
- **Go package profile** is separately `observe` by default. It recognizes successful, complete normal or `-v` Go test output from `bash`, reports potential package-summary savings, and persists no raw output in observe mode. Set both the extension mode and **Go package profile** to `apply` to store the complete successful raw stream before replacing package summaries (and, for verbose runs, runner/log detail) with tested/cached/no-test totals and a retrieval reference.
- **Vitest profile** is separately `observe` by default. It accepts only a complete standalone successful default- or verbose-reporter run: a `RUN v…` header, one unmixed contiguous pass-line variant, agreeing file/test totals, and the `Start at`/`Duration` summary. It preserves an optional shell preamble and replaces the recognized Vitest region with file/test totals, duration, and a retrieval reference. Console output, snapshots, failures, post-summary banners, reporter variants, and composite Go/Vitest streams pass through unchanged.
- **JSON/JSONL profile** is separately `observe` by default. It accepts complete JSON objects/arrays, strict JSONL records, or one or more independently verified JSON object/array blocks that begin on an otherwise indented line; it preserves all surrounding mixed-output text exactly. It removes only whitespace outside JSON strings, preserving duplicate keys, ordering, number and escape spelling, and Unicode text. For recovered Pi-truncated raw output, it emits complete minified content when it fits; otherwise it may emit a clearly marked incomplete minified tail with a retrieval reference. Inline/same-line JSON snippets, primitives, comments, malformed JSON, errors, and nontext output pass through unchanged.
- **`rg`/`grep` search-record profile** is separately `observe` by default. It accepts successful `bash` output only when a safe shell-segment parser finds an executed `rg` or `grep` command and every output line contains exactly one unambiguous `:<decimal>:` delimiter. It factors adjacent equal opaque prefixes into tagged groups while preserving every prefix, line token, suffix, and source order; prefixes are not assumed to be paths. ANSI/NUL output, headings, context, malformed/ambiguous records, uncertain shell syntax, errors, and nontext output pass through unchanged. Recovered Pi output is replaced only when the complete grouped rendering fits the visible-byte gate.
- Enable profiles independently with `profiles.test.go.mode`, `profiles.test.vitest.mode`, `profiles.structured.json.mode`, or `profiles.search.records.mode`; profile apply requires the extension mode and that profile mode to both be `apply`.
- Errors, image-bearing results, unconfigured tools, malformed/failed profile runs, storage failures, and cancellation pass through unchanged.

The default eligible tools are `read,bash`; change the comma-separated **Tool Output Compression → Eligible tools** setting in `/pi-tools` to opt in other text tools. Storage defaults to `~/.pi/agent/tool-output-compression.sqlite`, uses WAL and full synchronous durability, and exposes a raw-storage budget in MiB plus retention. Stored output is private to the creating session and can be recovered by the agent with `retrieve_tool_output` when a compression reference provides its id.

Use `/tool-output` for session savings, profile candidates/bypasses, and storage status. `/tool-output prune` removes expired output; `/tool-output vacuum` compacts the SQLite database. Profile compactness is compared against Pi's visible result (including a truncated tail), not against the recovered raw stream, so it never expands model context. JSON raw recovery begins with bounded binary head/tail probing and captures the complete artifact only after a positive JSON shape signal. Raw retrieval remains session-scoped through `retrieve_tool_output`.

## Configuration

pi-tools extensions share a versioned JSON configuration system. Defaults are overridden by the global file, then by a trusted project override:

```text
extension defaults
  < ~/.pi/agent/pi-tools.json
  < <project>/.pi/pi-tools.json
```

`PI_CODING_AGENT_DIR` changes the global file's parent directory. The project override is ignored until Pi trusts the project.

Use `/pi-tools` inside Pi to browse every registered setting, choose global or project scope, and save a change. It reloads Pi after a successful update. The command also supports:

```text
/pi-tools status
/pi-tools paths
/pi-tools get <extension.setting>
/pi-tools [--global|--project] set <extension.setting> <value>
/pi-tools [--global|--project] enable <extension>
/pi-tools [--global|--project] disable <extension>
```

You may edit either JSON file directly; run `/reload` afterward. For example:

```json
{
  "version": 1,
  "extensions": {
    "custom-stats-footer": {
      "enabled": true,
      "codexQuota": {
        "enabled": true,
        "refreshMinutes": 5
      }
    },
    "memory": { "enabled": true },
    "brave-search": { "enabled": true },
    "browser-tools": { "enabled": true }
  }
}
```

`enabled: false` disables an extension's behavior and removes its tools from the active set; Pi still loads its source module. Use native `pi config` to prevent Pi from loading an extension at all.

Existing `codex-quota-footer.json` settings are migrated into the shared global file on first use, then the legacy file is removed. Configuration holds ordinary scalar settings only—booleans, numbers, strings, and enums. Keep credentials in environment variables or Pi's credential storage, never in `pi-tools.json`.
