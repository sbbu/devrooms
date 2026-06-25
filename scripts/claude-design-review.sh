#!/usr/bin/env bash
set -euo pipefail

mkdir -p docs/design-reviews
out="docs/design-reviews/$(date -u +%Y%m%dT%H%M%SZ)-claude.md"
tmp="$out.tmp"

if command -v claude >/dev/null 2>&1; then
  claude_bin=(claude)
else
  claude_bin=(pnpm dlx @anthropic-ai/claude-code)
fi

if ! "${claude_bin[@]}" -p "You are doing a read-only UI/UX critique of devrooms. Inspect src/client/src/main.tsx and src/client/src/styles.css. Do not edit files. Return: (1) top 10 UX issues, (2) top 5 visual hierarchy fixes, (3) one strong design direction, (4) concrete implementation notes. Context: devrooms is a local-first cockpit for durable repo rooms, terminals, git diffs, and coding subagents. Avoid generic SaaS fluff." --allowedTools 'Read' --max-turns 6 > "$tmp"; then
  cat "$tmp" >&2 || true
  rm -f "$tmp"
  exit 1
fi

mv "$tmp" "$out"

echo "$out"
