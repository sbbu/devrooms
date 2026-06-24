# Devrooms Roadmap

Devrooms is aiming at a local-first cockpit for multi-agent development.

## Product north star

A project has many durable rooms. Each room is a full repository clone with its own terminal, git state, agent processes, and history. Switching rooms should feel like switching tabs, not doing git surgery.

## Current slice

- daemon + web UI
- persistent project/room registry
- full-clone room creation
- browser PTY terminal
- git status/diff/stage/unstage/commit/fetch/pull/push
- branch checkout/create
- agent preset launcher for Hermes, Codex, Claude Code, OpenCode
- Electron shell that starts or attaches to the local daemon
- smoke tests covering core daemon, git, process, and websocket paths

## Next slices

1. **Desktop packaging**
   - package the Electron shell for macOS
   - local tray/menu lifecycle for the daemon
   - preserve fast local typing

2. **Room ownership + process persistence**
   - room status: idle, human-owned, agent-owned, needs-attention
   - durable process records across daemon restarts
   - explicit attach/detach semantics

3. **Better git desktop controls**
   - partial hunk staging
   - side-by-side diff mode
   - commit history / branch graph
   - PR open/status panel

4. **Hermes-native integration**
   - open Hermes TUI with project/workspace skills preloaded
   - pass room metadata into Hermes session context
   - surface Hermes subagents as first-class room processes

5. **Remote daemon mode**
   - run daemon on a mini/homelab host
   - local app connects over a private websocket/tailscale address
   - auth layer before any non-local binding

6. **Design polish**
   - periodic Claude design critique pass
   - keyboard-first command palette
   - density modes for laptop vs large monitor
