import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseRoles } from './bastao.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASTAO_CLI = path.join(__dirname, 'bastao.mjs');

process.env.BASTAO_NOTIFY = 'off';

function runCli(args, cwd, env = {}) {
  return spawnSync(process.execPath, [BASTAO_CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BASTAO_NOTIFY: 'off', ...env }
  });
}

function tempRepo() {
  const base = path.join(os.tmpdir(), `bastao-teste-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const repoDir = path.join(base, 'pasta com espaço é');
  fs.mkdirSync(repoDir, { recursive: true });
  spawnSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  return repoDir;
}

test('parseRoles extrai implement e review corretamente', () => {
  const roles = parseRoles('implement:codex,review:claude+gemini');
  assert.deepEqual(roles, {
    implement: 'codex',
    review: ['claude', 'gemini']
  });
});

test('init cria turn.json com current_turn:claude e linhas no exclude sem duplicar', () => {
  const repo = tempRepo();
  const res = runCli([
    'init',
    '--task=Testar fluxo',
    '--slug=teste-fluxo',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    `--repo=${repo}`
  ], repo);

  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const turnPath = path.join(repo, '.agents', 'turn.json');
  assert.ok(fs.existsSync(turnPath));
  const raw = fs.readFileSync(turnPath);
  assert.equal(raw[0], 0x7B, 'Arquivo deve iniciar com { (sem BOM)');

  const state = JSON.parse(raw.toString('utf8'));
  assert.equal(state.current_turn, 'claude');
  assert.equal(state.status, 'IN_PROGRESS');
  assert.equal(state.action, 'spec');
  assert.equal(state.round, 1);
  assert.equal(state.max_rounds, 3);

  const excludePath = path.join(repo, '.git', 'info', 'exclude');
  const excludeContent = fs.readFileSync(excludePath, 'utf8');
  assert.ok(excludeContent.includes('.agents/turn.json'));
  assert.ok(excludeContent.includes('.agents/turn.json.tmp'));
  assert.ok(excludeContent.includes('.agents/*.lock'));
  assert.ok(excludeContent.includes('.agents/live/'));

  // Rodar de novo com --force deve atualizar sem duplicar exclude
  const res2 = runCli([
    'init',
    '--task=Testar fluxo 2',
    '--slug=teste-fluxo',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    '--force',
    `--repo=${repo}`
  ], repo);
  assert.equal(res2.status, 0);

  const excludeContent2 = fs.readFileSync(excludePath, 'utf8');
  const count = excludeContent2.split(/\r?\n/).map(l => l.trim()).filter(l => l === '.agents/turn.json').length;
  assert.equal(count, 1, 'Não deve duplicar linhas no exclude');
});

test('segundo init com ciclo ativo falha com código 1', () => {
  const repo = tempRepo();
  const res1 = runCli([
    'init',
    '--task=Testar fluxo',
    '--slug=teste-fluxo',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    `--repo=${repo}`
  ], repo);
  assert.equal(res1.status, 0);

  const res2 = runCli([
    'init',
    '--task=Outro fluxo',
    '--slug=outro-fluxo',
    '--spec=docs/spec2.md',
    '--plan=docs/plan2.md',
    `--repo=${repo}`
  ], repo);
  assert.equal(res2.status, 1);
  assert.match(res2.stderr, /ciclo ativo/i);
});

test('pass com notas especiais preserva acentos, aspas, quebras e sem BOM', () => {
  const repo = tempRepo();
  runCli([
    'init',
    '--task=Testar fluxo',
    '--slug=teste-fluxo',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    `--repo=${repo}`
  ], repo);

  const specialNotes = 'ação "x" & 100%\nlinha2';
  const res = runCli([
    'pass',
    '--from=claude',
    '--to=gemini',
    '--action=implement',
    `--notes=${specialNotes}`,
    `--repo=${repo}`
  ], repo);

  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const turnPath = path.join(repo, '.agents', 'turn.json');
  const raw = fs.readFileSync(turnPath);
  assert.equal(raw[0], 0x7B, 'Arquivo deve iniciar com { (sem BOM)');

  const state = JSON.parse(raw.toString('utf8'));
  assert.equal(state.current_turn, 'gemini');
  assert.equal(state.notes, specialNotes);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].notes, specialNotes);
});

test('pass de quem não está com o bastão falha com código 1 sem alterar turn.json', () => {
  const repo = tempRepo();
  runCli([
    'init',
    '--task=Testar fluxo',
    '--slug=teste-fluxo',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    `--repo=${repo}`
  ], repo);

  const turnPath = path.join(repo, '.agents', 'turn.json');
  const beforeBytes = fs.readFileSync(turnPath);

  const res = runCli([
    'pass',
    '--from=gemini',
    '--to=claude',
    '--action=review',
    `--repo=${repo}`
  ], repo);

  assert.equal(res.status, 1);
  const afterBytes = fs.readFileSync(turnPath);
  assert.deepEqual(afterBytes, beforeBytes, 'turn.json não deve ser alterado');
});

test('fluxo de rounds, fix, done, ask e pause', () => {
  const repo = tempRepo();
  runCli([
    'init',
    '--task=Testar fluxo',
    '--slug=teste-fluxo',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    '--max-rounds=3',
    `--repo=${repo}`
  ], repo);

  // 1. Pass claude -> gemini (implement)
  let res = runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', `--repo=${repo}`], repo);
  assert.equal(res.status, 0);

  // 2. gemini -> claude (review)
  res = runCli(['pass', '--from=gemini', '--to=claude', '--action=review', `--repo=${repo}`], repo);
  assert.equal(res.status, 0);

  // 3. claude -> gemini (fix round 2)
  res = runCli(['pass', '--from=claude', '--to=gemini', '--action=fix', `--repo=${repo}`], repo);
  assert.equal(res.status, 0);
  let state = JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'turn.json'), 'utf8'));
  assert.equal(state.round, 2);
  assert.equal(state.current_turn, 'gemini');

  // gemini -> claude (review round 2)
  res = runCli(['pass', '--from=gemini', '--to=claude', '--action=review', `--repo=${repo}`], repo);
  assert.equal(res.status, 0);

  // claude -> gemini (fix round 3)
  res = runCli(['pass', '--from=claude', '--to=gemini', '--action=fix', `--repo=${repo}`], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'turn.json'), 'utf8'));
  assert.equal(state.round, 3);

  // gemini -> claude (review round 3)
  res = runCli(['pass', '--from=gemini', '--to=claude', '--action=review', `--repo=${repo}`], repo);
  assert.equal(res.status, 0);

  // claude -> fix round 4 (ultrapassa max_rounds 3) -> MAX_ROUNDS_REACHED, current_turn: human
  res = runCli(['pass', '--from=claude', '--to=gemini', '--action=fix', `--repo=${repo}`], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'turn.json'), 'utf8'));
  assert.equal(state.status, 'MAX_ROUNDS_REACHED');
  assert.equal(state.current_turn, 'human');

  // done com to!=human deve falhar
  res = runCli(['pass', '--from=human', '--to=gemini', '--action=done', `--repo=${repo}`], repo);
  assert.equal(res.status, 1);

  // Retomar de MAX_ROUNDS_REACHED pelo human
  res = runCli(['pass', '--from=human', '--to=gemini', '--action=implement', `--repo=${repo}`], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'turn.json'), 'utf8'));
  assert.equal(state.status, 'IN_PROGRESS');
  assert.equal(state.current_turn, 'gemini');
  assert.equal(state.round, 4); // round mantido

  // ask por gemini -> WAITING_HUMAN
  res = runCli(['ask', '--from=gemini', '--question=Qual cor usar?', `--repo=${repo}`], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'turn.json'), 'utf8'));
  assert.equal(state.status, 'WAITING_HUMAN');
  assert.equal(state.ask_human.from, 'gemini');
  assert.equal(state.ask_human.question, 'Qual cor usar?');

  // pass de quem perguntou volta a IN_PROGRESS
  res = runCli(['pass', '--from=gemini', '--to=claude', '--action=review', `--repo=${repo}`], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'turn.json'), 'utf8'));
  assert.equal(state.status, 'IN_PROGRESS');
  assert.equal(state.ask_human, null);

  // pause -> MANUAL_PAUSE
  res = runCli(['pause', `--repo=${repo}`], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'turn.json'), 'utf8'));
  assert.equal(state.status, 'MANUAL_PAUSE');
  assert.equal(state.current_turn, 'human');

  // pass de human retoma mantendo round
  res = runCli(['pass', '--from=human', '--to=gemini', '--action=implement', `--repo=${repo}`], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'turn.json'), 'utf8'));
  assert.equal(state.status, 'IN_PROGRESS');
  assert.equal(state.current_turn, 'gemini');

  // done para human -> APPROVED
  res = runCli(['pass', '--from=gemini', '--to=human', '--action=done', `--repo=${repo}`], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'turn.json'), 'utf8'));
  assert.equal(state.status, 'APPROVED');
  assert.equal(state.current_turn, 'human');
});

test('status rodado de uma subpasta sem --repo detecta raiz git', () => {
  const repo = tempRepo();
  runCli([
    'init',
    '--task=Testar status',
    '--slug=teste-status',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    `--repo=${repo}`
  ], repo);

  const subDir = path.join(repo, 'sub', 'pasta', 'interna');
  fs.mkdirSync(subDir, { recursive: true });

  const res = runCli(['status'], subDir);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Vez de:\s*claude/i);
  assert.match(res.stdout, /Round:\s*1\/3/i);
});

test('turn.json inválido falha com código 1, mensagem clara e sem stack trace', () => {
  const repo = tempRepo();
  const agentsDir = path.join(repo, '.agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const turnPath = path.join(agentsDir, 'turn.json');
  fs.writeFileSync(turnPath, '{quebrado', 'utf8');

  const res = runCli(['status', `--repo=${repo}`], repo);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /turn\.json inválido/i);
  assert.doesNotMatch(res.stderr, /^\s+at\s+/m, 'stderr não deve conter stack trace');
  assert.equal(fs.readFileSync(turnPath, 'utf8'), '{quebrado', 'arquivo não deve ser alterado');
});
