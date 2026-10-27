import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decideStall, lastActivity, isParado } from './parada.mjs';
import { tempRepo, git } from './testutil.mjs';

const MIN = 60000;
const T0 = Date.parse('2026-10-27T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const base = (extra = {}) => ({ status: 'IN_PROGRESS', current_turn: 'gemini', parado_min: 15, stall: null, ...extra });

test('decideStall: dentro do limite não faz nada', () => {
  assert.deepEqual(decideStall(base(), { now: T0 + 14 * MIN, activityMs: T0, canRewake: true }), { action: 'none', stall: null });
});

test('decideStall: gemini acordável parado é reacordado uma vez', () => {
  const r = decideStall(base(), { now: T0 + 15 * MIN, activityMs: T0, canRewake: true });
  assert.equal(r.action, 'rewake');
  assert.deepEqual(r.stall, { since: iso(T0), rewake_at: iso(T0 + 15 * MIN), notified_at: null });
  const again = decideStall(base({ stall: r.stall }), { now: T0 + 20 * MIN, activityMs: T0, canRewake: true });
  assert.equal(again.action, 'none');
});

test('decideStall: depois do reenvio, avisa no dobro do tempo e só uma vez', () => {
  const stall = { since: iso(T0), rewake_at: iso(T0 + 15 * MIN), notified_at: null };
  const r = decideStall(base({ stall }), { now: T0 + 30 * MIN, activityMs: T0, canRewake: true });
  assert.equal(r.action, 'notify');
  assert.equal(r.stall.notified_at, iso(T0 + 30 * MIN));
  assert.equal(r.stall.rewake_at, stall.rewake_at);
  assert.equal(decideStall(base({ stall: r.stall }), { now: T0 + 90 * MIN, activityMs: T0, canRewake: true }).action, 'none');
});

test('decideStall: claude ou gemini sem conversa só avisa', () => {
  for (const st of [base({ current_turn: 'claude' }), base()]) {
    const r = decideStall(st, { now: T0 + 15 * MIN, activityMs: T0, canRewake: false });
    assert.equal(r.action, 'notify');
    assert.deepEqual(r.stall, { since: iso(T0), rewake_at: null, notified_at: iso(T0 + 15 * MIN) });
  }
});

test('decideStall: human, ciclo terminal ou pergunta pendente não contam', () => {
  for (const st of [base({ current_turn: 'human' }), base({ status: 'APPROVED' }), base({ status: 'WAITING_HUMAN' })]) {
    assert.equal(decideStall(st, { now: T0 + 60 * MIN, activityMs: T0, canRewake: true }).action, 'none');
  }
});

test('decideStall: atividade nova limpa a parada', () => {
  const stall = { since: iso(T0), rewake_at: iso(T0 + 15 * MIN), notified_at: iso(T0 + 30 * MIN) };
  assert.deepEqual(decideStall(base({ stall }), { now: T0 + 31 * MIN, activityMs: T0 + 31 * MIN, canRewake: true }),
    { action: 'clear', stall: null });
});

test('decideStall: limite fracionário vale (parado_min 0.5)', () => {
  assert.equal(decideStall(base({ parado_min: 0.5 }), { now: T0 + 31000, activityMs: T0, canRewake: false }).action, 'notify');
});

test('isParado só depois do aviso', () => {
  assert.equal(isParado(base()), false);
  assert.equal(isParado(base({ stall: { since: iso(T0), rewake_at: iso(T0), notified_at: null } })), false);
  assert.equal(isParado(base({ stall: { since: iso(T0), rewake_at: null, notified_at: iso(T0) } })), true);
});

test('lastActivity: arquivo alterado mais novo vence commit antigo; arquivo apagado não quebra', () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'ab', '--date=2020-01-01T00:00:00Z');
  const velho = Date.parse('2020-01-01T00:00:00Z');
  const commitTs = Number(git(repo, 'log', '-1', '--format=%ct').stdout.trim()) * 1000;
  const state = { history: [{ at: iso(velho), from: 'claude' }] };
  const branch = git(repo, 'branch', '--show-current').stdout.trim();

  fs.rmSync(path.join(repo, 'b.txt'));
  assert.equal(lastActivity({ dir: repo, branch, state }), commitTs);

  fs.writeFileSync(path.join(repo, 'a.txt'), 'mudou');
  const novo = new Date(commitTs + 3600_000);
  fs.utimesSync(path.join(repo, 'a.txt'), novo, novo);
  assert.equal(lastActivity({ dir: repo, branch, state }), novo.getTime());
});

test('lastActivity: eventos do próprio bastão (acordar) não contam como atividade', () => {
  const repo = tempRepo();
  const branch = git(repo, 'branch', '--show-current').stdout.trim();
  const commitTs = Number(git(repo, 'log', '-1', '--format=%ct').stdout.trim()) * 1000;
  const passou = commitTs + 1000;
  const state = { history: [
    { at: iso(passou), from: 'claude' },
    { at: iso(passou + 3600_000), from: 'bastao', action: 'wake' }
  ] };
  assert.equal(lastActivity({ dir: repo, branch, state }), passou);
});

test("isParado ignora ciclo terminal ou com human", () => {
  const stall = { since: iso(T0), rewake_at: null, notified_at: iso(T0) };
  assert.equal(isParado(base({ stall, status: "APPROVED", current_turn: "human" })), false);
  assert.equal(isParado(base({ stall, current_turn: "human" })), false);
});
