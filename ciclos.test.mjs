import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  cycleFromToplevel, resolveCycle, listCycles, toplevelOf, mainRepoOf,
  readIndex, addToIndex, removeFromIndex, indexPath
} from './ciclos.mjs';
import { tempRepo, git } from './testutil.mjs';

function escreveCiclo(repo, slug, extra = {}) {
  const dir = path.join(repo, '.agents', 'ciclos');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify({ slug, worktree: `.worktrees/${slug}`, ...extra }));
}

function escreveLegado(repo, slug) {
  fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.agents', 'turn.json'), JSON.stringify({ slug, version: 2 }));
}

test('cycleFromToplevel reconhece só a raiz de .worktrees/<slug>', () => {
  const repo = path.join('C:', 'r');
  assert.equal(cycleFromToplevel(repo, path.join(repo, '.worktrees', 'x')), 'x');
  assert.equal(cycleFromToplevel(repo, repo), null);
  assert.equal(cycleFromToplevel(repo, path.join(repo, 'src')), null);
});

test('resolveCycle: nenhum ciclo dá NO_CYCLE', () => {
  const repo = tempRepo();
  assert.throws(() => resolveCycle({ mainRepo: repo, toplevel: repo, explicitRequired: false }), { code: 'NO_CYCLE' });
});

test('resolveCycle: ciclo único na raiz só sem explicitRequired', () => {
  const repo = tempRepo();
  escreveCiclo(repo, 'a');
  const c = resolveCycle({ mainRepo: repo, toplevel: repo, explicitRequired: false });
  assert.equal(c.slug, 'a');
  assert.equal(c.legacy, false);
  assert.equal(c.paths.state, path.join(repo, '.agents', 'ciclos', 'a.json'));
  assert.equal(c.paths.lock('claude'), path.join(repo, '.agents', 'ciclos', 'a.wait-claude.lock'));
  assert.equal(c.paths.liveDir, path.join(repo, '.agents', 'live', 'a'));
  assert.equal(c.paths.worktree, path.join(repo, '.worktrees', 'a'));
  assert.throws(() => resolveCycle({ mainRepo: repo, toplevel: repo, explicitRequired: true }),
    err => err.code === 'EXPLICIT_CYCLE_REQUIRED' && /\.worktrees/.test(err.message));
  assert.equal(resolveCycle({ mainRepo: repo, toplevel: repo, ciclo: 'a', explicitRequired: true }).slug, 'a');
});

test('resolveCycle: dois ciclos sem --ciclo dá AMBIGUOUS_CYCLE listando os dois', () => {
  const repo = tempRepo();
  escreveCiclo(repo, 'a');
  escreveCiclo(repo, 'b');
  assert.throws(() => resolveCycle({ mainRepo: repo, toplevel: repo, explicitRequired: false }),
    err => err.code === 'AMBIGUOUS_CYCLE' && /\ba\b/.test(err.message) && /\bb\b/.test(err.message) && /--ciclo/.test(err.message));
  assert.throws(() => resolveCycle({ mainRepo: repo, toplevel: repo, ciclo: 'zz', explicitRequired: false }), { code: 'NO_CYCLE' });
});

test('resolveCycle: dentro de .worktrees/b usa b mesmo com explicitRequired', () => {
  const repo = tempRepo();
  escreveCiclo(repo, 'a');
  escreveCiclo(repo, 'b');
  const c = resolveCycle({ mainRepo: repo, toplevel: path.join(repo, '.worktrees', 'b'), explicitRequired: true });
  assert.equal(c.slug, 'b');
});

test('resolveCycle: legado único na raiz é aceito com explicitRequired', () => {
  const repo = tempRepo();
  escreveLegado(repo, 'leg');
  const c = resolveCycle({ mainRepo: repo, toplevel: repo, explicitRequired: true });
  assert.equal(c.slug, 'leg');
  assert.equal(c.legacy, true);
  assert.equal(c.paths.state, path.join(repo, '.agents', 'turn.json'));
  assert.equal(c.paths.lock('gemini'), path.join(repo, '.agents', 'wait-gemini.lock'));
  assert.equal(c.paths.liveDir, path.join(repo, '.agents', 'live'));
  assert.equal(c.paths.worktree, null);
});

test('listCycles junta ciclos novos e o legado', () => {
  const repo = tempRepo();
  escreveCiclo(repo, 'a');
  escreveLegado(repo, 'leg');
  assert.deepEqual(listCycles(repo), [{ slug: 'a', legacy: false }, { slug: 'leg', legacy: true }]);
});

test('subpasta de um worktree real infere o ciclo', () => {
  const repo = tempRepo();
  git(repo, 'worktree', 'add', '-b', 'ai/x', path.join(repo, '.worktrees', 'x'));
  const sub = path.join(repo, '.worktrees', 'x', 'src');
  fs.mkdirSync(sub);
  assert.equal(mainRepoOf(sub), path.normalize(repo));
  assert.equal(cycleFromToplevel(mainRepoOf(sub), toplevelOf(sub)), 'x');
});

test('índice: add idempotente, remove e arquivo corrompido', () => {
  fs.rmSync(indexPath(), { force: true });
  addToIndex('C:\\r1', 'a');
  addToIndex('C:\\r1', 'a');
  addToIndex('C:\\r2', 'b');
  assert.deepEqual(readIndex().ciclos.map(c => `${c.repo}|${c.slug}`), ['C:\\r1|a', 'C:\\r2|b']);
  removeFromIndex('C:\\r1', 'a');
  assert.deepEqual(readIndex().ciclos.map(c => c.slug), ['b']);
  fs.writeFileSync(indexPath(), '{quebrado');
  const idx = readIndex();
  assert.equal(idx.corrupt, true);
  assert.deepEqual(idx.ciclos, []);
  fs.rmSync(indexPath(), { force: true });
});
