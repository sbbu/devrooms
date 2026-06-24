# Devrooms

Devrooms is a local-first cockpit for multi-agent software work.

It gives each project durable room-style workspaces: full repo clones with a terminal, git status/diff controls, and attachable agent/subprocess terminals.

## Current v0

Devrooms currently ships as a daemon + web UI, plus an Electron shell:

- project registry
- room registry
- room creation via async full `git clone`
- remote PTY terminal streamed into the browser with xterm.js
- git branch/status/diff/stage/unstage/commit/fetch/pull/push controls
- subagent/process launcher with presets for Hermes, Codex, Claude Code, and OpenCode
- Electron desktop entrypoint that starts/attaches to the local daemon
- smoke coverage for project creation, room cloning, git operations, process launch, and websocket terminal attachment

See:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/ROADMAP.md`](docs/ROADMAP.md)

## Quick start

```bash
pnpm install
pnpm test
pnpm start
```

Open:

```text
http://127.0.0.1:4317
```

Daemon metadata:

```text
http://127.0.0.1:4317/api/meta
```

Dev mode:

```bash
pnpm dev
```

Desktop shell:

```bash
pnpm run desktop
```

Build and install a local macOS `.app` bundle:

```bash
pnpm run install:mac
```

The app is copied to:

```text
/Applications/Devrooms.app
```

For CI or local verification without touching `/Applications`:

```bash
pnpm run package:mac
pnpm run smoke:package
pnpm run smoke:install
```

The packaged app starts its own local daemon on `127.0.0.1:4317` unless `DEVROOMS_SERVER_URL` points at an already-running daemon.

Use:

1. Open `Devrooms.app`.
2. Create a project with a git repo URL/path.
3. Clone a room. Room creation is async; the room shows `creating`, then `idle` or `error`.
4. Use the tabs:
   - `terminal` for an interactive shell in the room clone.
   - `git` for status, diffs, stage/unstage, commit, branch, fetch/pull/push.
   - `subagents` to launch and attach agent/process PTYs.

Uninstall:

```bash
rm -rf /Applications/Devrooms.app ~/.devrooms ~/devrooms
```

`~/.devrooms` stores the registry state. `~/devrooms` stores the actual room clones.

Claude design critique pass, when Claude Code is installed/logged in:

```bash
pnpm run design:review
```

Review output is written under `docs/design-reviews/`.

The daemon stores state at:

```text
~/.devrooms/state.json
```

Rooms default to:

```text
~/devrooms/<project>/<room>
```

Override with:

```bash
DEVROOMS_HOME=/path/to/state DEVROOMS_ROOMS_ROOT=/path/to/rooms pnpm start
```

## Security

The daemon binds to `127.0.0.1` only. Do not expose it on a network interface until auth exists; it can run arbitrary commands inside room clones through terminals and agent launchers.
