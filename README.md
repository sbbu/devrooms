# devrooms

devrooms is a local-first cockpit for multi-agent software work.

It gives each project durable room-style workspaces: full repo clones with a terminal, git status/diff controls, and attachable agent/subprocess terminals.

## Current v0

devrooms currently ships as a daemon + web UI, plus an Electron shell:

- project registry
- room registry with a direct `main` room for a local repo and clone rooms for parallel work
- room creation via async full `git clone`
- remote PTY terminal streamed into the browser with xterm.js
- git branch/status/diff/stage/unstage/commit/fetch/pull/push controls
- subagent/process launcher with presets for Hermes, Codex, Claude Code, and OpenCode
- Electron desktop entrypoint that starts/attaches to the local daemon
- live development scripts for coding devrooms inside devrooms itself
- smoke coverage for local main rooms, project creation, room cloning, git operations, process launch, and websocket terminal attachment

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

In dev mode the daemon gets `DEVROOMS_PROJECT_PATH=$PWD`, so devrooms auto-registers the current git checkout as the default project and creates a `main` room that points directly at the repo instead of cloning it.

Live desktop dev mode, with Vite HMR for the UI and `tsx watch` for the daemon:

```bash
pnpm run dev:desktop
```

This opens Electron against the Vite dev server so you can use devrooms to work on devrooms itself.

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
/Applications/devrooms.app
```

For CI or local verification without touching `/Applications`:

```bash
pnpm run package:mac
pnpm run smoke:package
pnpm run smoke:install
```

The packaged app starts its own local daemon on `127.0.0.1:4317` unless `DEVROOMS_SERVER_URL` points at an already-running daemon.

Use:

1. Open `devrooms.app`.
2. Create a project with either:
   - a local repo path, which creates a direct `main` room; or
   - a git repo URL/path, which can be cloned into separate rooms.
3. Use the default `main` room for direct work on the source checkout, or clone extra rooms for isolated branches. Room creation is async; clone rooms show `creating`, then `idle` or `error`.
4. Use the tabs:
   - `terminal` for an interactive shell in the selected room.
   - `git` for status, diffs, stage/unstage, commit, branch, fetch/pull/push.
   - `subagents` to launch and attach agent/process PTYs.

Uninstall:

```bash
rm -rf /Applications/devrooms.app ~/.devrooms ~/devrooms
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
