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

Room directories live at `~/devrooms/<project>/<room>` unless `DEVROOMS_ROOMS_ROOT` is set. A project's direct `main` room points at the local repo path and is never placed under `DEVROOMS_ROOMS_ROOT`.

When `DEVROOMS_PROJECT_PATH` is set (the dev scripts set it to `$PWD`), startup auto-registers that git checkout as the default project and upserts a `main` room for it.

The registry stores only project/room metadata. Repository contents live in real git clones, not in the state file.

## Health / metadata

The daemon exposes:

- `GET /api/health` — liveness plus runtime metadata.
- `GET /api/meta` — runtime metadata, state paths, and project/room/process counts.

The project registry response also includes per-room process counts so the sidebar can surface running/lost agent state without opening each room.

Smoke tests verify these endpoints plus the built UI and SPA fallback are served from `dist/client`.

## Security boundary

The daemon currently binds to `127.0.0.1` only. Do not expose it on a network interface until auth exists. It can run arbitrary commands inside rooms through PTYs and agent launchers.

## Room model

A room is either:

- `main`: a direct pointer to an existing local git checkout for the project. This is the default room when a project has `rootPath`, and it lets Devrooms operate on the main repo without cloning.
- `clone`: a full clone of a project repository under `DEVROOMS_ROOMS_ROOT`. This avoids the state leakage and tooling friction that happen with git worktrees in large JS monorepos.

Clone-room creation is asynchronous: `POST /api/projects/:projectId/rooms` returns `202` with a `creating` room, then the daemon clones in the background and updates the room to `idle` or `error`. The UI polls the registry so long clones do not freeze the app.

Project creation accepts a git repo URL/path and optionally a local `rootPath`. A local `rootPath` is resolved to its git root and automatically creates/updates the project's `main` room. Project creation validates repository reachability and the default branch with `git ls-remote`. Deleting a `creating` room cancels the tracked clone process and tombstones that room generation so late clone completion cannot resurrect stale state. Deleting a `main` room only removes the registry row; Devrooms refuses to delete the main repo's files.

## Process model

Processes are PTYs spawned inside a room. The daemon persists process records in the state file. Live PTYs cannot be resurrected after daemon death, so any record that was `running` on startup is downgraded to `lost` with a clear log marker. Graceful shutdown marks live processes `exited`.

Every room shell/process gets `cwd=room.path` plus `TERMINAL_CWD`, `DEVROOMS_ROOM_ID`, `DEVROOMS_ROOM_NAME`, `DEVROOMS_ROOM_PATH`, `DEVROOMS_ROOM_KIND`, and `DEVROOMS_PROJECT_ID`. Hermes launched from a room therefore sees the room path in its system prompt and runs file/terminal tools from that room.

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
