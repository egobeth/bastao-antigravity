import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const git = (dir, args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });

// Última atividade do dono do bastão, em ms: arquivos alterados no worktree, último commit da branch e
// último evento do histórico que não seja do próprio bastão (acordar não é atividade de ninguém).
export function lastActivity({ dir, branch, state, liveDir = null }) {
  const events = (state.history || []).filter(h => h.from !== 'bastao');
  if (events.length === 0) return Date.now();
  let last = Date.parse(events.at(-1).at) || 0;

  if (liveDir) {
    try {
      last = Math.max(last, fs.statSync(path.join(liveDir, 'codex.log')).mtimeMs);
    } catch {}
  }

  const log = git(dir, ['log', '-1', '--format=%ct', branch]);
  if (log.status === 0) last = Math.max(last, Number(log.stdout.trim()) * 1000 || 0);

  const st = git(dir, ['status', '--porcelain=v1', '-uall', '-z']);
  if (st.status === 0) {
    const entries = st.stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.length < 4) continue;
      if (e[0] === 'R' || e[0] === 'C') i++; // o próximo campo é o caminho de origem
      try {
        last = Math.max(last, fs.statSync(path.join(dir, e.slice(3))).mtimeMs);
      } catch {}
    }
  }
  return last;
}

export function decideStall(state, { now, activityMs, canRewake }) {
  const stall = state.stall ?? null;
  if (state.status !== 'IN_PROGRESS' || state.current_turn === 'human') return { action: 'none', stall };
  if (stall && activityMs > Date.parse(stall.since)) return { action: 'clear', stall: null };

  const limit = state.parado_min * 60000;
  const rewakeLimit = limit / 5;
  const idle = now - activityMs;
  const iso = ms => new Date(ms).toISOString();

  if (canRewake) {
    if (idle < rewakeLimit) return { action: 'none', stall };
    if (!stall) {
      return { action: 'rewake', stall: { since: iso(activityMs), rewake_at: iso(now), notified_at: null } };
    }
    if (idle >= limit && stall.rewake_at && !stall.notified_at) {
      return { action: 'notify', stall: { ...stall, notified_at: iso(now) } };
    }
    return { action: 'none', stall };
  }

  if (idle < limit) return { action: 'none', stall };
  if (!stall) {
    return { action: 'notify', stall: { since: iso(activityMs), rewake_at: null, notified_at: iso(now) } };
  }
  return { action: 'none', stall };
}

export const isParado = state =>
  state.status === 'IN_PROGRESS' && state.current_turn !== 'human' && !!state.stall?.notified_at;
