# pi-tools

A [pi](https://github.com/badlogic/pi-mono) package.
Adds web search using Brave Search API and managed browser tooling.

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

Browser Tools manages Playwright Chromium sessions on macOS. It uses the Chromium version pinned by the package, not your installed Brave or Chrome. If the matching browser is missing, automatic installation requires a trusted project and `browser-tools.autoInstall` enabled. If automatic installation is disabled, install the matching Chromium with the package's pinned Playwright CLI. `/pi-tools` controls these settings; project overrides apply only to trusted projects.

#### Sessions and login

The agent can start a visible session with `browser_session` arguments `{"action":"start"}` or a headless session with `{"action":"start","headless":true}`. Sessions are visible by default and disposable unless a string `profile` name is supplied. `browser_session` also lists sessions, creates and selects tabs, closes tabs, and stops sessions. Tools accept session and tab IDs; selections and owned sessions are scoped to the creating Pi session. Stop owned sessions when finished.

For reusable login, start a visible session with a named profile, for example `{"action":"start","profile":"work"}`. Named profiles live under `~/.pi/agent/browser-profiles` and retain login data. They are exclusively leased across cooperating sessions; contention waits up to `profileWaitTimeoutMs`, and uncertain ownership fails closed. They are separate from your personal browser profiles. The toolkit does not copy or delete those profiles, and the old `profile: true` option is not a migration path.

Use `browser_handoff` with `action: "pause"` for a human login or MFA step. Automation pauses until the user sends the exact `browser-resume` instruction returned by the tool in interactive Pi or an RPC client with UI. Diagnostic history is discarded and capture suspended during handoff. Download capture remains suspended after confirmation until explicitly resumed with `browser_download` and risk acknowledgment; delayed human downloads may then be captured. A headless named-profile session can request a visible restart with separate user consent, but open tabs, unsaved forms and in-memory state may be lost. Old IDs expire. A disposable headless session cannot be converted this way.

#### Tools and data

| Tool                                                                           | Purpose                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_session`, `browser_navigate`                                          | Manage owned sessions and tabs; navigate the selected or explicitly addressed tab.                                                                                                                                                 |
| `browser_snapshot`, `browser_snapshot_ref`, `browser_action`                   | Inspect bounded semantic records, validate or click retained references, and perform scoped actions. References expire on navigation or the next snapshot. Actions can have uncertain outcomes and are not automatically replayed. |
| `browser_handoff`, `browser_pick`                                              | Pause for a human or collect visual selections in a visible session. Picker results are non-actionable metadata, not selectors; frame changes cancel selection.                                                                    |
| `browser_content`, `browser_eval`, `browser_extract`                           | Inspect main-document HTML, evaluate a main-frame expression, or extract readable content. HTML excludes iframe documents and shadow roots and may not reflect runtime form state.                                                 |
| `browser_upload`, `browser_dialog`                                             | Upload explicitly listed local files or inspect and resolve owned-page dialogs.                                                                                                                                                    |
| `browser_screenshot`, `browser_viewport`                                       | Set viewport dimensions and capture viewport, full-page, or snapshot-reference element PNGs. Screenshots return image content and artifact metadata.                                                                               |
| `browser_diagnostics`, `browser_diagnostic_headers`, `browser_diagnostic_body` | Read bounded console/network history, explicitly reveal selected sensitive headers, or configure body capture.                                                                                                                     |
| `browser_download`, `browser_recording`, `browser_artifact`                    | Manage captured downloads, traces and video, and read, export or clean managed artifacts.                                                                                                                                          |
| `browser_attachment`                                                           | Experimental, limited direct CDP access to an explicitly selected external page.                                                                                                                                                   |

`browser_start`, `browser_stop`, `browser_cookies`, and `browser_logs` are removed. Use `browser_session` and `browser_diagnostics` instead where applicable. `browser_navigate` no longer accepts the old `newTab` or `reload` parameters; create or select a tab through `browser_session`. `browser_screenshot` now returns PNG image content rather than a temporary filename.

Diagnostics capture bounded console and network metadata by default. Console text, page content, URLs and explicitly revealed headers can contain secrets. With diagnostics enabled, body capture is on by default for `development` sessions, the default purpose, and off by default for `research` sessions. Use `browser_diagnostic_body` with `action: "configure"` to enable or disable capture for future requests. Captured bodies may contain secrets. Response bodies are best effort for completed, declared-small uncompressed responses. Retained bytes are bounded, but transient browser, transport and Node memory are not strictly bounded. Requests are never replayed for capture. History is cleared when its tab or session is invalidated.

Large inspection results, screenshots, downloads, recordings and explicitly saved bodies can produce private artifacts under `~/.pi/agent/browser-artifacts`. IDs are scoped to the creating Pi session. `browser_artifact` reads bounded text or base64 binary chunks, exports to a new absolute path without overwriting, or runs cleanup. Default quota is 256 MiB and retention is one hour; cleanup is opportunistic, so do not rely on immediate deletion. Traces and video can contain sensitive page data. Recording has a default five-minute deadline, but native temporary recording files are not size-capped by the artifact quota.

For an existing Chromium browser, `browser_attachment` requires a trusted project, an explicit literal-loopback CDP endpoint, and selection of an explicitly discovered target ID. The tool does not enforce a separate user confirmation; obtain the user's approval before selecting a page. It leases one selected page and supports bounded title and DOM text reads, HTTP(S) navigation, and opt-in console-level and network metadata. DOM text may include hidden content and secrets. It does not support actions, screenshots, uploads, dialogs, recordings or full Playwright access. Disconnect closes the attachment, not the external tab or browser. Failed or uncertain operations can quarantine the lease; do not assume they were replayed or completed.

Settings include `autoInstall`, diagnostic history limits, startup and navigation deadlines, upload and screenshot limits, artifact quota and retention, and the recording deadline. See `/pi-tools` for defaults and permitted ranges. Browser state and artifacts may contain credentials; protect the local account and exported files.

### `code-search`

Local AST-aware code navigation for trusted projects. Use **Code Search → Mode** in `/pi-tools` to select `observe` (index only) or `apply` (enables its navigation tools).

Code Search requires native `better-sqlite3` and Tree-sitter bindings. If Pi reports a missing `better-sqlite3` binding, change to the pi-tools package directory—the directory containing this repository's `package.json` (for example, `/your/repos/pi-tools` from the local install above)—and run the command for your npm version:

```bash
# npm 11
npm approve-scripts --all

# npm 12+
npm install-scripts --all
```

Restart Pi or run `/reload` after the scripts complete.

### `custom-stats-footer`

Replaces Pi's default footer with context usage and last/average response tokens per second. TPS is measured from each assistant response's stream start to finish and therefore excludes time spent executing tools; the average is weighted by response tokens and stream duration.

If you happen to be using a codex subscription, enable **Custom Stats Footer → codexQuota.enabled** in `/pi-tools` to see your remaining weekly quota. This uses your existing `openai-codex` ChatGPT subscription login, refreshes every five minutes, and stores its settings in the shared `~/.pi/agent/pi-tools.json` file.

The quota source is an undocumented ChatGPT endpoint, so the feature is best-effort. Access tokens and account identifiers are used only in memory and are never written or displayed by the extension.

### `subagents`

Persistent task workers and research jobs have independent model and thinking settings in `/pi-tools` → Subagents. Model pickers use Pi's scoped models when configured, otherwise available models. Choosing `inherit` for a model uses the parent's model.

Set **Task-worker thinking** (`thinking.task`) and **Research-job thinking** (`thinking.research`) to `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Saving `inherit` copies the parent's current thinking when a worker session starts. Any saved thinking choice overrides a `:thinking` suffix in its model setting. If the thinking setting has never been saved, its default is `inherit`, but an existing model suffix still takes precedence for compatibility. Without a suffix it inherits parent thinking.

Pi clamps thinking to the selected model's capabilities. These settings do not change the parent's model or thinking and apply only to new worker sessions; existing sessions retain their settings.

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
