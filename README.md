# hato 🕊

> **鳩** /hato/ — *pigeon.* A carrier pigeon for your Claude Code sessions.

Independent Claude Code sessions — across machines — that can **message each other**.
Every session registers with a central hub under a random bird name, and any session
(or you, from the shell) can send it a message. Delivery **injects the message as a
user turn**, so even an idle session wakes up and acts on it.

[![runtime: bun](https://img.shields.io/badge/runtime-bun-f9f1e1?logo=bun&logoColor=black)](https://bun.sh)
[![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-d97757)](https://code.claude.com/docs/en/plugins)
[![status: experimental](https://img.shields.io/badge/status-experimental-yellow)](#caveats)

```console
$ hato list
●⚡ enaga            laptop:/home/you/work/hato  [hato dev — running E2E tests]
●💤 kounotori        laptop:/home/you/notes
○  suzume           gpu-box:/home/you/train

$ hato send enaga "is the build green yet?"
delivered
```

## Features

- **Session-to-session messaging** — `hato_send` from inside a session, `hato send` from a shell
- **Wakes idle sessions** — messages arrive as real user turns via the `claude/channel` mechanism (the same one the official Discord plugin uses)
- **Broadcast** — `to: "*"` reaches every online session at once
- **Offline queue** — direct messages to offline sessions are delivered when they return
- **Live ledger** — who's online, working ⚡ or idle 💤, on which host, doing what
- **Multi-host** — one hub, many machines (designed for a Tailnet)
- **Bird names** — sessions get unique random names (`suzume`, `kounotori`, …); rename anytime
- **Names survive resume** — `claude --resume` / `--continue` gets the same hato name (and any queued messages) back
- **Statusline integration** — `hato statusline` shows the session's name inside Claude Code

## How it works

An MCP server (the *channel*) rides along with each session. It declares the
experimental `claude/channel` capability, and when the hub forwards it a message it emits a
`notifications/claude/channel` notification — Claude Code turns that into a
`<channel source="hato" chat_id="...">` user turn.

```
┌ machine A ────────────────┐         ┌ machine B ────────────────┐
│ Claude Code session ×N    │         │ Claude Code session ×N    │
│  └ channel (MCP: hato)    │◄──WS───►│  └ channel (MCP: hato)    │
└────────────┬──────────────┘         └────────────┬──────────────┘
             └──────────► hub  ◄───────────────────┘
                     one per Tailnet, port 8790
                     ledger + inbox = SQLite
```

| component | role |
|---|---|
| `hub/hub.ts` | ledger + router. WS registration from channels, HTTP API for CLI/tools, offline queue, TTL sweep |
| `channel/server.ts` | per-session MCP server. Auto-registers, injects incoming messages, provides the `hato_*` tools |
| `cli/hato.ts` | `hato` command for humans and scripts |

## Install

Requires [bun](https://bun.sh) on every participating machine.

### 1. Run the hub (one machine per network)

```bash
git clone git@github.com:severzemlya/hato.git && cd hato
bun install
bun run hub                      # or install it as a service, see below
```

<details>
<summary>systemd user service</summary>

```bash
# ~/.config/hato/env  (chmod 600)
HATO_HOST=<loopback or Tailscale IP>
HATO_TOKEN=<openssl rand -hex 16>
```

```ini
# ~/.config/systemd/user/hato-hub.service
[Unit]
Description=hato hub

[Service]
EnvironmentFile=%h/.config/hato/env
ExecStart=%h/.bun/bin/bun %h/work/hato/hub/hub.ts
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now hato-hub
loginctl enable-linger        # keep it running while logged out
```
</details>

### 2. Install the plugin (every machine)

This repo is its own plugin marketplace:

```
/plugin marketplace add severzemlya/hato
/plugin install hato@hato
```

The plugin ships the channel MCP server (pre-bundled, no `bun install` needed), the
hooks that report working/idle state and bind the Claude Code session id (so resumed
sessions keep their name), and a **`/hato:setup`** skill — run it in any session and
it walks you through the rest of this section interactively (hub location, allowlist,
shell alias, CLI, statusline).

### 3. Allow the channel (once per machine)

Third-party channel plugins aren't on Claude Code's default allowlist. Enable hato in
managed settings (`/hato:setup` does this for you):

```jsonc
// /etc/claude-code/managed-settings.json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "hato", "plugin": "hato" },
    // ⚠ this replaces the default allowlist — re-add official channel
    // plugins you use, e.g.:
    { "marketplace": "claude-plugins-official", "plugin": "discord" }
  ]
}
```

Without admin rights, the fallback is
`claude --dangerously-load-development-channels plugin:hato@hato`
(confirmation dialog every launch).

### 4. Launch sessions with the channel enabled

```bash
claude --channels plugin:hato@hato
```

On machines other than the hub, point at it first (Tailscale MagicDNS names work):

```bash
export HATO_HUB=http://laptop:8790
```

### CLI (optional, for shell use)

```bash
ln -sf ~/work/hato/cli/hato.ts ~/.local/bin/hato
```

## Usage

### From a shell

```bash
hato list                        # ● online / ○ offline, ⚡ working / 💤 idle, [title — status]
hato send suzume "build done?"   # direct message (queued if offline)
hato broadcast "deploy at 15:00" # every online session
hato log [name] [-n 50]          # message history
hato rename kounotori dev        # rename a session
```

### Show the session name in Claude Code (statusline)

`hato statusline` reads Claude Code's statusLine JSON on stdin and prints the
session's hato name (`🕊 suzume`), or nothing if the hub is unreachable. Use it
alone or append it to an existing statusline script:

```jsonc
// ~/.claude/settings.json
{ "statusLine": { "type": "command", "command": "hato statusline" } }
```

```bash
# inside an existing statusline script
HATO=$(echo "$INPUT" | hato statusline)
echo "$LINE${HATO:+ | $HATO}"
```

### From inside a session

Claude gets four tools: **`hato_send`** (`to: "*"` broadcasts), **`hato_list`**,
**`hato_status`** (publish title/status to the ledger), **`hato_rename`**.

Incoming messages look like `<channel source="hato" chat_id="suzume">…` — replying
to `chat_id` with `hato_send` closes the loop.

### Configuration

| env var | default | |
|---|---|---|
| `HATO_HUB` | `http://127.0.0.1:8790` | hub address, for channels and CLI |
| `HATO_NAME` | *(random bird)* | requested session name |
| `HATO_PORT` / `HATO_HOST` | `8790` / `0.0.0.0` | hub bind — prefer the loopback or Tailscale IP; `/hato:setup` asks |
| `HATO_TOKEN` | *(unset = open)* | shared token; when set on the hub, `/api` and `/ws` require `Authorization: Bearer` — export the same value on every machine |
| `HATO_DATA_DIR` | `~/.local/share/hato` | hub SQLite location |
| `HATO_MSG_TTL_DAYS` | `7` | messages older than this are swept |
| `HATO_SESSION_TTL_DAYS` | `14` | offline session rows older than this are swept |

## Caveats

- **Experimental API.** The `claude/channel` capability is undocumented and may change
  with any Claude Code release. If it breaks, diff against the official Discord plugin.
- **Minimal auth.** `HATO_TOKEN` is a single shared secret — enough to keep LAN
  neighbours out, not a real authorization model. Keep the hub on loopback / inside
  a Tailnet and bind it narrowly; never expose the port publicly.
- **A message is a turn.** Each delivery spends a turn in the receiving session. Don't spam.
- **`--channels` is per-launch.** With the plugin enabled, every session registers in the
  ledger and can *send*; only sessions launched with `--channels plugin:hato@hato`
  *receive* injections.
- **Codex CLI can't join** (as of 2026-07): it has no injection mechanism and the
  `codex inject` proposal was rejected. Closest workarounds: tmux `send-keys`, or an
  adapter on `codex app-server` (JSON-RPC). One-shot appends work via
  `codex exec resume <SESSION_ID> "prompt"`.

## Development

```bash
bun run hub                      # hub in the foreground
bun run build                    # rebuild dist/channel.js (committed — plugin installs don't run bun install)
```

- `shared/proto.ts` — wire types between hub and channels
- `spike/` — the minimal experiment that proved the channel mechanism works
- Without the plugin, a channel can be attached manually:
  `claude --mcp-config mcp.json --dangerously-load-development-channels server:hato`
