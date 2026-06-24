# Devrooms Architecture

## Shape

```text
Devrooms Electron shell or browser UI
  -> HTTP/WebSocket daemon on 127.0.0.1
      -> state file
      -> room directories
      -> git commands
      -> PTY processes
```

The current implementation is intentionally small: one Node daemon, one React/Vite client, one Electron shell, and xterm.js terminals.

The Electron shell starts `dist/server.js` unless `DEVROOMS_SERVER_URL` points at an already-running daemon.

## State

State lives at `~/.devrooms/state.json` unless `DEVROOMS_HOME` is set.

Room directories live at `~/devrooms/<project>/<room>` unless `DEVROOMS_ROOMS_ROOT` is set.

The registry stores only project/room metadata. Repository contents live in real git clones, not in the state file.

## Health / metadata

The daemon exposes:

- `GET /api/health` — liveness plus runtime metadata.
- `GET /api/meta` — runtime metadata, state paths, and project/room/process counts.

Smoke tests verify these endpoints plus the built UI and SPA fallback are served from `dist/client`.

## Security boundary

The daemon currently binds to `127.0.0.1` only. Do not expose it on a network interface until auth exists. It can run arbitrary commands inside rooms through PTYs and agent launchers.

## Room model

A room is a full clone of a project repository. This avoids the state leakage and tooling friction that happen with git worktrees in large JS monorepos.

## Process model

Processes are PTYs spawned inside a room. The daemon keeps in-memory logs and statuses while it is running. Future work should persist process records across daemon restarts, but PTYs themselves cannot be resurrected after daemon death.

## Git model

Git operations are shell-execed through `git` in the room directory. The daemon validates file paths stay inside the room before per-file operations.

Supported now:

- status
- branch list
- checkout
- create branch
- diff, including untracked files
- stage / unstage
- commit staged files
- fetch / pull --ff-only / push with upstream

## UI model

The UI is a cockpit, not an editor. It should make rooms, terminals, git diffs, and agent processes legible at a glance. Code editing still happens in terminal/editor/agent tools.
