# pi-opencode-subs

Pi extension for managing **OpenCode Go subscription workspaces**. Automatically sets the active workspace API key, displays usage bars in the footer, and rotates keys on rate limits.

## Install

From this git repo (recommended):

```bash
pi install git:github.com:EugeneKallis/pi-opencode-subs
```

Or from a local checkout:

```bash
pi install /path/to/pi-opencode-subs
```

## Setup

Each OpenCode Go subscription has its own workspace ID + API key. Add them via the `/go-subs` command:

```bash
/go-subs add personal wrk_xxx sk-xxx [auth_cookie]
/go-subs add backup wrk_yyy sk-yyy [auth_cookie]
```

Or edit the config file directly:

```bash
vim ~/.pi/agent/opencode-subs.json
```

### Getting workspace details

1. Go to https://opencode.ai/settings/api-keys
2. Create or copy an API key for each workspace
3. Get the workspace ID from the URL or API keys page
4. (Optional) Grab the `auth` cookie from the dashboard for usage-scrape fallback

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/go-subs` / `/go-subs status` | List all workspaces + show active usage bars |
| `/go-subs use <name>` | Switch to a specific workspace |
| `/go-subs next` / `/go-subs rotate` | Cycle to the next workspace |
| `/go-subs add <name> <id> <key> [cookie]` | Add a new workspace |
| `/go-subs rm <name>` | Remove a workspace |
| `/go-subs setup` | Create/verify the config file |

### Auto-features

- **Startup**: Sets the active workspace API key so all LLM calls use the right subscription
- **Footer bars**: Shows rolling (R), weekly (W), and monthly (M) usage as colored bars in the TUI footer (polled every 30s)
- **Rate-limit rotation**: Detects HTTP 429 / rate-limit errors and automatically rotates to the next workspace

## Config file

Data lives in `~/.pi/agent/opencode-subs.json` (global, survives reinstalls):

```json
{
  "_active": "personal",
  "personal": {
    "workspace_id": "wrk_xxx",
    "workspace_api_key": "sk-xxx"
  },
  "backup": {
    "workspace_id": "wrk_yyy",
    "workspace_api_key": "sk-yyy",
    "auth_cookie": "Fe26.2..."
  }
}
```

## Requirements

- pi (pi-coding-agent) v0.80+
- OpenCode Go provider configured (`opencode-go` in `~/.pi/agent/settings.json`)
- One or more OpenCode API keys
