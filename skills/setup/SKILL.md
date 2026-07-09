---
name: setup
description: Interactive setup and health check for hato — hub location (local/remote), channel allowlist (managed settings), shell alias, CLI install. Run after installing the plugin, or anytime to diagnose.
---

# /hato:setup — hato Setup & Health Check

Guides the user through everything hato needs on this machine: where the hub
lives, the channel allowlist, an optional shell alias, and the `hato` CLI.
Also serves as a diagnostic when something stops working.

Talk to the user in their language; keep file contents and commands as-is.

---

## Step 1 — Gather state (always, before anything else)

Collect all of this quietly, then present one status summary:

1. **bun** — `command -v bun` (also try `~/.bun/bin/bun`). Required for
   everything; if missing, offer `curl -fsSL https://bun.sh/install | bash`.
2. **Plugin files** — resolve the newest version dir:
   `PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hato/hato/*/ | sort -V | tail -1)`.
3. **Hub** — determine the effective hub URL: `$HATO_HUB` if set, else
   `http://127.0.0.1:8790`. Probe it: `curl -sf --max-time 2 <url>/healthz`.
   Also check for a local service: `systemctl --user is-active hato-hub`.
4. **Token** — `/healthz` is always open, so probe auth separately:
   `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $HATO_TOKEN" <url>/api/sessions`.
   `401` means the hub requires a token and the local `HATO_TOKEN` is missing
   or wrong; `200` with no `HATO_TOKEN` set means the hub is running open.
5. **Allowlist** — read `/etc/claude-code/managed-settings.json`. Needed
   state: `channelsEnabled: true` and an `allowedChannelPlugins` entry
   `{"marketplace": "hato", "plugin": "hato"}`.
6. **Alias** — detect the user's login shell (`$SHELL`). Look for existing
   hato wiring: fish → a `claude` function in `~/.config/fish/config.fish`
   or `conf.d/*.fish` mentioning `plugin:hato@hato`; bash/zsh → same grep in
   `~/.bashrc` / `~/.bashrc.d/` / `~/.zshrc`.
7. **CLI** — `command -v hato`.
8. **HATO_HUB / HATO_TOKEN persistence** — if the hub is remote or requires
   a token, are they exported in shell config (not just the current
   environment)?

Show a compact status list (✅/❌ per item), then dispatch:

- **Everything green** → say so, remind the launch command
  (`claude --channels plugin:hato@hato` or their alias), stop.
- **Gaps** → continue to Step 2 and only configure what's missing or what
  the user wants to change.

## Step 2 — Ask the user (AskUserQuestion, one call, only the open items)

**Q1: Where is the hub?** (skip if a hub is already reachable and the user
isn't trying to move it)
- *This machine* — run it here as a systemd user service (recommended for
  the machine that is always on)
- *Remote* — a hub already runs (or will run) on another host; follow up
  for the hostname if not obvious (Tailscale MagicDNS names like
  `http://<hub-host>:8790` work)

**Q1b: Bind address?** (only when the hub runs on this machine — never
default silently, the hub has at most token auth)
- *Loopback (`127.0.0.1`)* — single-machine use, nothing else can connect
- *Tailscale IP* — multi-machine over a Tailnet; get it with
  `tailscale ip -4`. Recommended default, and the safe choice when the
  machine has no firewall
- *All interfaces (`0.0.0.0`)* — only when a firewall restricts the port
  (e.g. ufw allowing only `tailscale0`); warn otherwise

**Q1c: Require a shared token?** (ask whenever the bind is not loopback;
recommend *yes*)
- *Yes* — generate one (`openssl rand -hex 16`) or reuse the existing hub
  token; every participating machine must export the same `HATO_TOKEN`
- *No* — anyone who can reach the port can read the ledger and send
  messages; acceptable on loopback, risky elsewhere

**Q2: Shell alias?**
- *`--hato` shorthand (recommended)* — `claude --hato` expands to
  `claude --channels plugin:hato@hato`; plain `claude` stays untouched
- *Always on* — every `claude` launch joins hato automatically
- *None* — type `--channels plugin:hato@hato` manually

**Q3: Install the `hato` CLI to ~/.local/bin?** (yes/no — lets the user and
Claude's Bash tool run `hato list` / `hato send` from any shell)

## Step 3 — Apply

### Hub: this machine

Prefer a git clone (`git clone git@github.com:severzemlya/hato.git`,
location up to the user, `~/work/hato` is the convention) so the hub
survives plugin updates; `bun install` is NOT needed for the hub.

Put the bind address and token in an env file the unit reads (mode 600 —
the token is a credential):

```bash
# ~/.config/hato/env
HATO_HOST=<bind address from Q1b>
HATO_TOKEN=<token from Q1c, omit the line if running open>
```

```ini
# ~/.config/systemd/user/hato-hub.service
[Unit]
Description=hato hub
After=network-online.target

[Service]
EnvironmentFile=%h/.config/hato/env
ExecStart=<bun path> <clone>/hub/hub.ts
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

`systemctl --user daemon-reload && systemctl --user enable --now hato-hub`,
then verify `curl -sf http://<bind address>:8790/healthz`. If the machine
should serve the hub while logged out, also `loginctl enable-linger`.

If the user declines a clone, fall back to the plugin cache with a version
glob wrapper — warn that it needs the service restarted after plugin
updates:
`ExecStart=/bin/bash -lc 'exec bun "$(ls -d ~/.claude/plugins/cache/hato/hato/*/ | sort -V | tail -1)hub/hub.ts"'`

### Hub: remote

Persist `HATO_HUB` (and `HATO_TOKEN` if the hub requires one) for login
shells so the channel, hooks, and CLI all see them:

- fish → `~/.config/fish/conf.d/hato.fish`:
  `set -gx HATO_HUB http://<host>:8790` (+ `set -gx HATO_TOKEN <token>`)
- bash → `~/.bashrc.d/hato.sh` (if sourced) or append to `~/.bashrc`:
  `export HATO_HUB=http://<host>:8790` (+ `export HATO_TOKEN=<token>`)
- zsh → `~/.zshrc`

Verify with `curl -sf --max-time 3 <url>/healthz`, then auth with
`curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer <token>" <url>/api/sessions`
(expect `200`). If unreachable, check Tailscale is up before blaming the
config. The hub machine itself also counts as "remote" here for its own
sessions when the hub binds to a non-loopback address — persist the same
variables there too.

### Allowlist (required once per machine — sudo)

Third-party channel plugins are not on Claude Code's default allowlist;
without this, injection is silently blocked ("not on the approved channels
allowlist" at launch). Confirm with the user before touching a system file.

**Merge, never overwrite**, `/etc/claude-code/managed-settings.json`:
- Ensure `"channelsEnabled": true`
- Ensure `allowedChannelPlugins` contains `{"marketplace": "hato", "plugin": "hato"}`

⚠️ Setting `allowedChannelPlugins` **replaces the default Anthropic
allowlist**. If the file is being created fresh, ask whether the user uses
official channel plugins (Discord, Telegram) and include those entries too,
e.g. `{"marketplace": "claude-plugins-official", "plugin": "discord"}`.
If the key already exists, only append the hato entry.

No sudo on this machine → the fallback is
`claude --dangerously-load-development-channels plugin:hato@hato`
(shows a confirmation dialog every launch).

### Alias

Implement per shell. fish gets a function (supports the shorthand cleanly);
bash/zsh get a function too — an alias can't rewrite `--hato` mid-args.

fish, shorthand — merge into an existing `claude` function if one exists
(add an `else if` branch), otherwise create `~/.config/fish/conf.d/hato.fish`:

```fish
function claude
    set -l args
    for arg in $argv
        if test "$arg" = "--hato"
            set args $args --channels plugin:hato@hato
        else
            set args $args $arg
        end
    end
    command claude $args
end
```

bash/zsh, shorthand (`~/.bashrc.d/hato.sh` or `~/.zshrc`):

```bash
claude() {
  local args=()
  for a in "$@"; do
    [ "$a" = "--hato" ] && args+=(--channels plugin:hato@hato) || args+=("$a")
  done
  command claude "${args[@]}"
}
```

Always-on variants: skip the loop and simply
`command claude --channels plugin:hato@hato $argv` / `"$@"`.

If a `claude` wrapper already exists, edit it — don't shadow it with a
second definition that would silently win or lose depending on load order.

### CLI

Symlink from a clone if one exists:
`ln -sf <clone>/cli/hato.ts ~/.local/bin/hato`

No clone → write a wrapper surviving plugin updates:

```bash
#!/usr/bin/env bash
exec bun "$(ls -d ~/.claude/plugins/cache/hato/hato/*/ | sort -V | tail -1)cli/hato.ts" "$@"
```

`chmod +x ~/.local/bin/hato`. Warn if `~/.local/bin` is not on PATH.

## Step 4 — Verify and hand off

1. `hato list` (or `bun <plugin>/cli/hato.ts list`) against the configured
   hub — reachable = setup is wired.
2. Tell the user: **restart the session** (or open a new one) with
   `claude --channels plugin:hato@hato` / their alias. At launch the banner
   must show *"messages from plugin:hato@hato inject directly in this
   session"* **without** an allowlist warning line under it.
3. Optional live test from another shell:
   `hato send <their-session-name> "ping"` — it should appear in-session as
   `← hato · …`.

## Notes

- Aliases and env persist per shell config; the *current* shell won't have
  them until re-sourced — say so.
- The token is minimal shared-secret auth, not a substitute for network
  isolation: keep the hub on loopback / a Tailnet. Never suggest exposing
  the port beyond that.
- Changing or adding the hub token requires updating `HATO_TOKEN` on every
  participating machine and restarting the hub; running sessions reconnect
  with the old value until relaunched.
- Sessions launched without `--channels` still register in the ledger and
  can send, but do not receive injections. That's expected, not a bug.
