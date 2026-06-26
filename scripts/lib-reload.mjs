import { spawn } from 'node:child_process';
import { watch, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// A file is mid-conflict while it carries BOTH the opening and closing merge markers
// git writes. Requiring both avoids tripping on a lone `=======` in normal source.
const MARK_OPEN = /^<{7}[ \t]/m;
const MARK_CLOSE = /^>{7}[ \t]/m;
const SOURCE_RE = /\.(ts|tsx|cts|mts|js|cjs|mjs|json)$/;

export function fileHasConflictMarkers(file) {
  try {
    const text = readFileSync(file, 'utf8');
    return MARK_OPEN.test(text) && MARK_CLOSE.test(text);
  } catch {
    return false;
  }
}

export function listSources(dir, excludeDir, acc = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (excludeDir && full === excludeDir) continue;
      listSources(full, excludeDir, acc);
    } else if (SOURCE_RE.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

export function conflictedSources(watchDir, excludeDir) {
  return listSources(watchDir, excludeDir).filter(fileHasConflictMarkers);
}

// Supervise a child process, reloading it when watched sources change — but NEVER
// while any of them has merge conflict markers. Reloading a half-merged source would
// crash the new process and take the whole thing down (devrooms watches its own src),
// so we keep the last-good child running and wait for the merge to be resolved.
// Returns { stop(signal) }.
export function superviseReload({ cmd, args, cwd, env, watchDir, excludeDir, label = 'process', debounceMs = 250, log = console.error }) {
  let child = null;
  let stopping = false;
  let timer = null;
  const rel = (file) => path.relative(cwd, file);

  function warnConflicts(bad) {
    log(`\n⚠ merge conflict markers in:\n   ${bad.map(rel).join('\n   ')}\n   ${label} NOT reloaded — resolve the merge (commit merge / abort) to resume.\n`);
  }
  function start() {
    const proc = spawn(cmd, args, { cwd, env, stdio: 'inherit' });
    proc.alive = true;
    // Bind to THIS proc, not the shared `child` (which reload() reassigns) — otherwise
    // an old child's exit would mutate the new child / a null.
    proc.on('exit', (code, signal) => {
      proc.alive = false;
      if (stopping) process.exit(code ?? (signal ? 1 : 0));
    });
    child = proc;
  }
  function reload(trigger) {
    const bad = conflictedSources(watchDir, excludeDir);
    if (bad.length) { warnConflicts(bad); return; } // keep the current child alive
    log(`↻ reloading ${label} (${trigger})`);
    if (child && child.alive) { const old = child; child = null; old.once('exit', start); old.kill('SIGTERM'); }
    else start();
  }

  const initial = conflictedSources(watchDir, excludeDir);
  if (initial.length) warnConflicts(initial); else start();

  const watcher = watch(watchDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const full = path.join(watchDir, String(filename));
    if (!SOURCE_RE.test(full)) return;
    if (excludeDir && (full === excludeDir || full.startsWith(excludeDir + path.sep))) return;
    clearTimeout(timer);
    timer = setTimeout(() => reload(rel(full)), debounceMs);
  });

  return {
    stop(signal = 'SIGTERM') {
      stopping = true;
      try { watcher.close(); } catch { /* noop */ }
      if (child && child.alive) child.kill(signal); else process.exit(0);
    },
  };
}
