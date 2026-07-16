# pi-tools

A [pi](https://github.com/badlogic/pi-mono) package.
Adds web search using Brave Search API and browser tooling via Chrome DevTools Protocol.

***I use Mac, feel free to fork and tweak for Windows/Linux!***

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


| Tool | Description |
|------|-------------|
| `browser_start` | Launch Brave with remote debugging on `:9222`. Pass `profile: true` to copy your default Brave profile (cookies, logins, extensions). |
| `browser_stop` | Kill the spawned Brave process |
| `browser_navigate` | Navigate to a URL (new tab or current tab) |
| `browser_eval` | Execute JavaScript in the active tab |
| `browser_screenshot` | Capture viewport or full page to a PNG |
| `browser_content` | Return raw page HTML (un-truncated) |
| `browser_cookies` | List cookies for the current tab |
| `browser_pick` | Interactive element picker — click to select |

### `custom-stats-footer`

Replaces Pi's default footer with context usage and last/average tokens per second.

If you happen to be using a codex subscription, you can toggle `/codex-quota` in Pi to see your remaining weekly quota. This  uses your existing `openai-codex` ChatGPT subscription login, refreshes every five minutes, and stores only the enabled setting in `~/.pi/agent/codex-quota-footer.json`. `/codex-quota on` and `/codex-quota off` remain available for explicit control.

The quota source is an undocumented ChatGPT endpoint, so the feature is best-effort. Access tokens and account identifiers are used only in memory and are never written or displayed by the extension.


