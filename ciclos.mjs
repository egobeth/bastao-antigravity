import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BastaoError } from './erro.mjs';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function gitOut(dir, args) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout) throw new BastaoError('Diretório não é um repositório git', 'NOT_GIT');
  return path.normalize(res.stdout.trim());
}

// Pasta principal do repositório, a mesma vista de qualquer worktree.
export function mainRepoOf(dir) {
  return path.dirname(gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

export function toplevelOf(dir) {
  return gitOut(dir, ['rev-parse', '--show-toplevel']);
}

export function cycleFromToplevel(mainRepo, toplevel) {
  const parts = path.relative(mainRepo, toplevel).split(path.sep);
  return parts.length === 2 && parts[0] === '.worktrees' ? parts[1] : null;
}

export function cyclePaths(mainRepo, slug, legacy) {
  const agents = path.join(mainRepo, '.agents');
  if (legacy) {
    return {
      state: path.join(agents, 'turn.json'),
      lock: agent => path.join(agents, `wait-${agent}.lock`),
      liveDir: path.join(agents, 'live'),
      worktree: null
    };
  }
  return {
    state: path.join(agents, 'ciclos', `${slug}.json`),
    lock: agent => path.join(agents, 'ciclos', `${slug}.wait-${agent}.lock`),
    liveDir: path.join(agents, 'live', slug),
    worktree: path.join(mainRepo, '.worktrees', slug)
  };
}

export function listCycles(mainRepo) {
  const dir = path.join(mainRepo, '.agents', 'ciclos');
  const cycles = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => ({ slug: f.slice(0, -5), legacy: false }))
    : [];
  const turn = path.join(mainRepo, '.agents', 'turn.json');
  if (fs.existsSync(turn)) {
    let slug = 'legado';
    try { slug = JSON.parse(fs.readFileSync(turn, 'utf8')).slug || slug; } catch {}
    cycles.push({ slug, legacy: true });
  }
  return cycles;
}

export function resolveCycle({ mainRepo, toplevel, ciclo, explicitRequired }) {
  const cycles = listCycles(mainRepo);
  const names = cycles.map(c => c.slug).join(', ') || '(nenhum)';
  const pick = c => ({ slug: c.slug, legacy: c.legacy, paths: cyclePaths(mainRepo, c.slug, c.legacy) });

  const wanted = ciclo || cycleFromToplevel(mainRepo, toplevel);
  if (wanted) {
    const found = cycles.find(c => c.slug === wanted);
    if (!found) throw new BastaoError(`Ciclo "${wanted}" não existe neste repositório (ciclos: ${names})`, 'NO_CYCLE');
    return pick(found);
  }
  if (cycles.length === 0) throw new BastaoError('Nenhum ciclo ativo neste repositório', 'NO_CYCLE');
  if (cycles.length > 1) {
    throw new BastaoError(`Há ${cycles.length} ciclos neste repositório (${names}); indique qual com --ciclo=<slug>`, 'AMBIGUOUS_CYCLE');
  }
  const [only] = cycles;
  if (explicitRequired && !only.legacy) {
    const wt = cyclePaths(mainRepo, only.slug, false).worktree;
    throw new BastaoError(`Na pasta principal, indique o ciclo com --ciclo=${only.slug} (ou trabalhe em ${wt})`, 'EXPLICIT_CYCLE_REQUIRED');
  }
  return pick(only);
}

export function indexPath() {
  return process.env.BASTAO_INDEX
    || path.join(process.env.USERPROFILE || process.env.HOME || '', '.agents', 'bastao-ciclos.json');
}

export function readIndex() {
  const file = indexPath();
  if (!fs.existsSync(file)) return { ciclos: [], corrupt: false };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ciclos: Array.isArray(data.ciclos) ? data.ciclos : [], corrupt: false };
  } catch {
    return { ciclos: [], corrupt: true };
  }
}

function writeIndex(ciclos) {
  const file = indexPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify({ ciclos }, null, 2) + '\n', 'utf8');
  fs.renameSync(file + '.tmp', file);
}

const sameEntry = (e, repo, slug) => e.slug === slug && path.normalize(e.repo).toLowerCase() === path.normalize(repo).toLowerCase();

export function addToIndex(repo, slug) {
  const { ciclos } = readIndex();
  if (ciclos.some(e => sameEntry(e, repo, slug))) return;
  writeIndex([...ciclos, { repo, slug, criado_em: new Date().toISOString() }]);
}

export function removeFromIndex(repo, slug) {
  const { ciclos } = readIndex();
  writeIndex(ciclos.filter(e => !sameEntry(e, repo, slug)));
}
