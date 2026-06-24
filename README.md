# Devrooms

Devrooms is a local-first cockpit for multi-agent software work.

It gives each project durable room-style workspaces: full repo clones with a terminal, git status/diff controls, and attachable agent/subprocess terminals.

## Current v0

This first cut is a working web daemon/UI:

- project registry
- room registry
- room creation via full `git clone`
- remote PTY terminal streamed into the browser with xterm.js
- git branch/status/diff/stage/unstage/fetch/pull/push endpoints
- subagent/process launcher with attachable PTY logs

Electron/local Hermes Client integration comes next; the daemon and room model are the foundation.

## Quick start

```bash
pnpm install
pnpm build
pnpm start
```

Open:

```text
http://127.0.0.1:4317
```

Dev mode:

```bash
pnpm dev
```

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

## GitHub identity

This repo is owned and authored as `sbbu`, not `sbbu-hermes` / `hermes`.
