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

Replaces Pi's default footer with context usage and last/average tokens per second.

If you happen to be using a codex subscription, enable **Custom Stats Footer → codexQuota.enabled** in `/pi-tools` to see your remaining weekly quota. This uses your existing `openai-codex` ChatGPT subscription login, refreshes every five minutes, and stores its settings in the shared `~/.pi/agent/pi-tools.json` file.

The quota source is an undocumented ChatGPT endpoint, so the feature is best-effort. Access tokens and account identifiers are used only in memory and are never written or displayed by the extension.

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
