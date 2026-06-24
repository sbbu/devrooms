# Devrooms ship checklist

Devrooms is daily-driver ready when a user can install it, open it like a desktop app, create/operate rooms without touching the terminal, and recover from normal failures without losing track of agent work.

## Must ship before daily-driver use

- [x] macOS desktop package builds from CI/local command.
- [x] installed app starts or attaches to the local daemon reliably.
- [ ] daemon lifecycle is visible in the UI: healthy, starting, unreachable, version, state path, room path.
- [ ] app has an in-app ready/error screen instead of quitting silently when daemon startup fails.
- [ ] project creation validates repo URL/path and reports clone errors clearly.
- [ ] room creation is async and cancel/delete-safe while cloning.
- [ ] room deletion is deliberate and removes/archives the clone safely.
- [x] process records survive daemon restart with a clear `lost` state for PTYs that cannot be reattached.
- [ ] running process / agent state is obvious at room and project level.
- [ ] git panel covers daily commit loop: status, unstaged/staged diff, stage/unstage, commit, branch, fetch/pull/push.
- [ ] smoke covers install-adjacent paths: package build, daemon restart, process persistence downgrade, failed clone/delete.
- [ ] README has install/start/use/uninstall instructions.
- [ ] local-only security boundary is documented and enforced.

## Nice after first daily-driver build

- [ ] partial hunk staging.
- [ ] side-by-side diff mode.
- [ ] PR creation/status panel.
- [ ] command palette.
- [ ] Claude design pass artifacts checked into `docs/design-reviews/`.
- [ ] Hermes-native room launch with skill/context injection.

## Current release rule

Every loop must pass:

```bash
pnpm test
```

Before pushing, also run whitespace, public-identity, and secrets scans from the Devrooms development runbook.

Do not call it ready until GitHub Actions is green on the final commit.
