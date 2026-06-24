# Devrooms

Devrooms is a local-first cockpit for multi-agent software work.

It gives each project durable room-style workspaces: full repo clones with a terminal, git status/diff controls, and attachable agent/subprocess terminals.

## Current v0

Devrooms currently ships as a daemon + web UI, plus an Electron shell:

- project registry
- room registry
- room creation via full `git clone`
- remote PTY terminal streamed into the browser with xterm.js
- git branch/status/diff/stage/unstage/commit/fetch/pull/push controls
- subagent/process launcher with presets for Hermes, Codex, Claude Code, and OpenCode
- Electron desktop entrypoint that starts/attaches to the local daemon
- smoke coverage for project creation, room cloning, git operations, process launch, and websocket terminal attachment

See:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/ROADMAP.md`](docs/ROADMAP.md)

Native packaging and deeper local Hermes Client integration come next; the daemon and room model are the foundation.

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
