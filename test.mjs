import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseRoles, wakeText } from './bastao.mjs';
import { BASTAO_CLI, ROOT, runCli, tempRepo, git } from './testutil.mjs';

// Ciclo único do repo de teste (nenhum antes do init).
function unicoCiclo(repo) {
  const dir = path.join(repo, '.agents', 'ciclos');
  const nomes = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
  return nomes.length === 1 ? nomes[0].slice(0, -5) : null;
}
const alvo = repo => (unicoCiclo(repo) ? [`--repo=${repo}`, `--ciclo=${unicoCiclo(repo)}`] : [`--repo=${repo}`]);
const estadoPath = repo => path.join(repo, '.agents', 'ciclos', `${unicoCiclo(repo)}.json`);
const lockPath = (repo, agente) => path.join(repo, '.agents', 'ciclos', `${unicoCiclo(repo)}.wait-${agente}.lock`);

test('parseRoles extrai implement e review corretamente', () => {
  const roles = parseRoles('implement:codex,review:claude+gemini');
  assert.deepEqual(roles, {
    implement: 'codex',
    review: ['claude', 'gemini']
  });
});

test('parseRoles recusa parte sem ":", papel desconhecido e agente inválido', () => {
  assert.throws(() => parseRoles('implement:gemini, review:claude, codex'), /"codex".*\+/);
  assert.throws(() => parseRoles('implementer:gemini'), /implementer/);
  assert.throws(() => parseRoles('review:claude+codx'), /codx/);
  assert.deepEqual(parseRoles('implement:codex,'), { implement: 'codex', review: ['claude'] });
});

test('init cria worktree na branch ai/<slug>, estado v3, exclude sem duplicar e entrada no índice', () => {
  const repo = tempRepo();
  const res = runCli([
    'init',
    '--task=Testar fluxo',
    '--slug=teste-fluxo',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    ...alvo(repo)
  ], repo);

  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const turnPath = estadoPath(repo);
  assert.equal(turnPath, path.join(repo, '.agents', 'ciclos', 'teste-fluxo.json'));
  const raw = fs.readFileSync(turnPath);
  assert.equal(raw[0], 0x7B, 'Arquivo deve iniciar com { (sem BOM)');

  const state = JSON.parse(raw.toString('utf8'));
  assert.equal(state.version, 3);
  assert.equal(state.current_turn, 'claude');
  assert.equal(state.status, 'IN_PROGRESS');
  assert.equal(state.action, 'spec');
  assert.equal(state.round, 1);
  assert.equal(state.max_rounds, 3);
  assert.equal(state.seq, 0);
  assert.equal(state.worktree, '.worktrees/teste-fluxo');
  assert.equal(state.parado_min, 15);
  assert.equal(state.wake, null);
  assert.equal(state.stall, null);

  const wt = path.join(repo, '.worktrees', 'teste-fluxo');
  assert.equal(git(wt, 'branch', '--show-current').stdout.trim(), 'ai/teste-fluxo');
  assert.match(res.stdout, /npm install/);
  assert.ok(res.stdout.includes(wt), 'imprime o caminho do worktree');

  const indice = JSON.parse(fs.readFileSync(process.env.BASTAO_INDEX, 'utf8'));
  assert.ok(indice.ciclos.some(c => c.repo === repo && c.slug === 'teste-fluxo'));

  const excludePath = path.join(repo, '.git', 'info', 'exclude');
  const excludeContent = fs.readFileSync(excludePath, 'utf8');
  for (const linha of ['.agents/turn.json', '.agents/*.lock', '.agents/live/', '.agents/ciclos/', '.worktrees/']) {
    assert.ok(excludeContent.includes(linha), linha);
  }
  assert.equal(git(repo, 'status', '--porcelain').stdout.trim(), '', 'pasta principal continua limpa');

  // Rodar de novo com --force reaproveita o worktree e não duplica o exclude
  const res2 = runCli([
    'init',
    '--task=Testar fluxo 2',
    '--slug=teste-fluxo',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    '--force',
    ...alvo(repo)
  ], repo);
  assert.equal(res2.status, 0, `stderr: ${res2.stderr}`);

  const excludeContent2 = fs.readFileSync(excludePath, 'utf8');
  const count = excludeContent2.split(/\r?\n/).map(l => l.trim()).filter(l => l === '.worktrees/').length;
  assert.equal(count, 1, 'Não deve duplicar linhas no exclude');
});

test('init: mesmo slug falha, slug diferente cria segundo ciclo e segundo worktree', () => {
  const repo = tempRepo();
  const init = slug => runCli(['init', `--task=${slug}`, `--slug=${slug}`, '--spec=s', '--plan=p', `--repo=${repo}`], repo);
  assert.equal(init('um').status, 0);
  const repetido = init('um');
  assert.equal(repetido.status, 1);
  assert.match(repetido.stderr, /já existe/i);
  const outro = init('dois');
  assert.equal(outro.status, 0, `stderr: ${outro.stderr}`);
  assert.ok(fs.existsSync(path.join(repo, '.agents', 'ciclos', 'um.json')));
  assert.ok(fs.existsSync(path.join(repo, '.agents', 'ciclos', 'dois.json')));
  assert.equal(git(path.join(repo, '.worktrees', 'dois'), 'branch', '--show-current').stdout.trim(), 'ai/dois');
});

test('init reaproveita branch ai/<slug> existente', () => {
  const repo = tempRepo();
  git(repo, 'branch', 'ai/existente');
  git(repo, 'commit', '--allow-empty', '-m', 'depois da branch');
  const res = runCli(['init', '--task=t', '--slug=existente', '--spec=s', '--plan=p', `--repo=${repo}`], repo);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const wt = path.join(repo, '.worktrees', 'existente');
  assert.equal(git(wt, 'rev-parse', 'HEAD').stdout, git(repo, 'rev-parse', 'ai/existente').stdout);
});

test('init recusa slug inválido sem criar nada', () => {
  const repo = tempRepo();
  const res = runCli(['init', '--task=t', '--slug=Meu Ciclo', '--spec=s', '--plan=p', `--repo=${repo}`], repo);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /slug/i);
  assert.equal(git(repo, 'branch', '--list', 'ai/*').stdout.trim(), '');
  assert.ok(!fs.existsSync(path.join(repo, '.agents', 'ciclos')));
});

test('init falha claro quando ai/<slug> está em uso na pasta principal', () => {
  const repo = tempRepo();
  git(repo, 'checkout', '-b', 'ai/x');
  const before = fs.existsSync(process.env.BASTAO_INDEX) ? fs.readFileSync(process.env.BASTAO_INDEX, 'utf8') : '';
  const res = runCli(['init', '--task=t', '--slug=x', '--spec=s', '--plan=p', `--repo=${repo}`], repo);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /ai\/x/);
  assert.match(res.stderr, /em uso/i);
  assert.doesNotMatch(res.stderr, /^\s+at\s+/m);
  assert.ok(!fs.existsSync(path.join(repo, '.agents', 'ciclos', 'x.json')));
  const after = fs.existsSync(process.env.BASTAO_INDEX) ? fs.readFileSync(process.env.BASTAO_INDEX, 'utf8') : '';
  assert.equal(after, before);
});

test('init avisa spec/plano ausentes no worktree e config sem .worktrees', () => {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'docs', 'spec.md'), 'spec');
  fs.writeFileSync(path.join(repo, 'vitest.config.ts'), 'export default {}');
  fs.writeFileSync(path.join(repo, 'eslint.config.js'), "export default [{ ignores: ['.worktrees/**'] }]");
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const res = runCli(['init', '--task=t', '--slug=avisos', '--spec=docs/spec.md', '--plan=docs/nao.md', `--repo=${repo}`], repo);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /docs\/nao\.md/);
  assert.doesNotMatch(res.stdout, /docs\/spec\.md.*não/);
  assert.match(res.stdout, /vitest\.config\.ts/);
  assert.doesNotMatch(res.stdout, /eslint\.config\.js/);
});

test('pass com notas especiais preserva acentos, aspas, quebras e sem BOM', () => {
  const repo = tempRepo();
  runCli([
    'init',
    '--task=Testar fluxo',
    '--slug=teste-fluxo',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    ...alvo(repo)
  ], repo);

  const specialNotes = 'ação "x" & 100%\nlinha2';
  const res = runCli([
    'pass',
    '--from=claude',
    '--to=gemini',
    '--action=implement',
    `--notes=${specialNotes}`,
    ...alvo(repo)
  ], repo);

  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const turnPath = estadoPath(repo);
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
    ...alvo(repo)
  ], repo);

  const turnPath = estadoPath(repo);
  const beforeBytes = fs.readFileSync(turnPath);

  const res = runCli([
    'pass',
    '--from=gemini',
    '--to=claude',
    '--action=review',
    ...alvo(repo)
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
    ...alvo(repo)
  ], repo);

  // 1. Pass claude -> gemini (implement)
  let res = runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', ...alvo(repo)], repo);
  assert.equal(res.status, 0);

  // 2. gemini -> claude (review)
  res = runCli(['pass', '--from=gemini', '--to=claude', '--action=review', ...alvo(repo)], repo);
  assert.equal(res.status, 0);

  // 3. claude -> gemini (fix round 2)
  res = runCli(['pass', '--from=claude', '--to=gemini', '--action=fix', ...alvo(repo)], repo);
  assert.equal(res.status, 0);
  let state = JSON.parse(fs.readFileSync(estadoPath(repo), 'utf8'));
  assert.equal(state.round, 2);
  assert.equal(state.current_turn, 'gemini');

  // gemini -> claude (review round 2)
  res = runCli(['pass', '--from=gemini', '--to=claude', '--action=review', ...alvo(repo)], repo);
  assert.equal(res.status, 0);

  // claude -> gemini (fix round 3)
  res = runCli(['pass', '--from=claude', '--to=gemini', '--action=fix', ...alvo(repo)], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(estadoPath(repo), 'utf8'));
  assert.equal(state.round, 3);

  // gemini -> claude (review round 3)
  res = runCli(['pass', '--from=gemini', '--to=claude', '--action=review', ...alvo(repo)], repo);
  assert.equal(res.status, 0);

  // claude -> fix round 4 (ultrapassa max_rounds 3) -> MAX_ROUNDS_REACHED, current_turn: human
  res = runCli(['pass', '--from=claude', '--to=gemini', '--action=fix', ...alvo(repo)], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(estadoPath(repo), 'utf8'));
  assert.equal(state.status, 'MAX_ROUNDS_REACHED');
  assert.equal(state.current_turn, 'human');

  // done com to!=human deve falhar
  res = runCli(['pass', '--from=human', '--to=gemini', '--action=done', ...alvo(repo)], repo);
  assert.equal(res.status, 1);

  // Retomar de MAX_ROUNDS_REACHED pelo human
  res = runCli(['pass', '--from=human', '--to=gemini', '--action=implement', ...alvo(repo)], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(estadoPath(repo), 'utf8'));
  assert.equal(state.status, 'IN_PROGRESS');
  assert.equal(state.current_turn, 'gemini');
  assert.equal(state.round, 4); // round mantido

  // ask por gemini -> WAITING_HUMAN
  res = runCli(['ask', '--from=gemini', '--question=Qual cor usar?', ...alvo(repo)], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(estadoPath(repo), 'utf8'));
  assert.equal(state.status, 'WAITING_HUMAN');
  assert.equal(state.ask_human.from, 'gemini');
  assert.equal(state.ask_human.question, 'Qual cor usar?');

  // pass de quem perguntou volta a IN_PROGRESS
  res = runCli(['pass', '--from=gemini', '--to=claude', '--action=review', ...alvo(repo)], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(estadoPath(repo), 'utf8'));
  assert.equal(state.status, 'IN_PROGRESS');
  assert.equal(state.ask_human, null);

  // pause -> MANUAL_PAUSE
  res = runCli(['pause', ...alvo(repo)], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(estadoPath(repo), 'utf8'));
  assert.equal(state.status, 'MANUAL_PAUSE');
  assert.equal(state.current_turn, 'human');

  // pass de human retoma mantendo round
  res = runCli(['pass', '--from=human', '--to=gemini', '--action=implement', ...alvo(repo)], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(estadoPath(repo), 'utf8'));
  assert.equal(state.status, 'IN_PROGRESS');
  assert.equal(state.current_turn, 'gemini');

  // done para human -> APPROVED
  res = runCli(['pass', '--from=gemini', '--to=human', '--action=done', ...alvo(repo)], repo);
  assert.equal(res.status, 0);
  state = JSON.parse(fs.readFileSync(estadoPath(repo), 'utf8'));
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
    ...alvo(repo)
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

  const res = runCli(['status', ...alvo(repo)], repo);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /turn\.json inválido/i);
  assert.doesNotMatch(res.stderr, /^\s+at\s+/m, 'stderr não deve conter stack trace');
  assert.equal(fs.readFileSync(turnPath, 'utf8'), '{quebrado', 'arquivo não deve ser alterado');
});

// --- Task 2: wait, lock e wake tests ---

function setupFakeAgentApi() {
  const tmpDir = fs.mkdtempSync(path.join(ROOT, 'fake-agentapi-'));
  const scriptPath = path.join(tmpDir, 'fake-agentapi.mjs');
  const logPath = path.join(tmpDir, 'fake.log');
  fs.writeFileSync(scriptPath, `import fs from 'node:fs';
const log = process.env.FAKE_LOG;
if (log) {
  fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n', 'utf8');
}
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`, 'utf8');
  return { scriptPath, logPath };
}

test('wait: ja e a vez de gemini sai 0 em menos de 1 s', () => {
  const repo = tempRepo();
  runCli([
    'init',
    '--task=Testar wait',
    '--slug=teste-wait',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    ...alvo(repo)
  ], repo);

  // claude passa para gemini
  runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', ...alvo(repo)], repo);

  const start = Date.now();
  const res = runCli(['wait', '--for=gemini', '--wake=conv-t', ...alvo(repo)], repo, { BASTAO_POLL_MS: '50' });
  const elapsed = Date.now() - start;

  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.ok(elapsed < 1500, `Demorou ${elapsed}ms, esperado < 1500ms`);
  assert.match(res.stdout, /Vez de:\s*gemini/i);
});

test('wait: vez do claude, pass para gemini acorda via wake sem caracteres proibidos', async () => {
  const repo = tempRepo();
  const { scriptPath, logPath } = setupFakeAgentApi();

  runCli([
    'init',
    '--task=Testar wait wake',
    '--slug=teste-wake',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    ...alvo(repo)
  ], repo);

  const geminiId = 'conv-123-gemini';
  const waitProc = spawn(process.execPath, [
    BASTAO_CLI,
    'wait',
    '--for=gemini',
    `--wake=${geminiId}`,
    ...alvo(repo)
  ], {
    cwd: repo,
    env: {
      ...process.env,
      BASTAO_NOTIFY: 'off',
      BASTAO_POLL_MS: '50',
      BASTAO_AGENTAPI: scriptPath,
      FAKE_LOG: logPath
    }
  });

  await new Promise(r => setTimeout(r, 200));
  runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', ...alvo(repo)], repo);

  const code = await new Promise(resolve => waitProc.on('close', resolve));

  assert.equal(code, 0);
  assert.ok(fs.existsSync(logPath), 'Log do fake agentapi deve existir');
  const logContent = fs.readFileSync(logPath, 'utf8');
  assert.ok(logContent.includes('send-message'));
  assert.ok(logContent.includes(geminiId));
  const parsed = JSON.parse(logContent.trim());
  const wakeText = parsed[3];
  // Proibidos: & | < > ^ " %
  assert.doesNotMatch(wakeText, /[&|<>^"%]/);
});

test('wait: status terminal APPROVED sai 3', () => {
  const repo = tempRepo();
  runCli([
    'init',
    '--task=Testar status terminal',
    '--slug=teste-term',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    ...alvo(repo)
  ], repo);

  // Leva a APPROVED
  runCli(['pass', '--from=claude', '--to=human', '--action=done', ...alvo(repo)], repo);

  const res = runCli(['wait', '--for=claude', ...alvo(repo)], repo, { BASTAO_POLL_MS: '50' });
  assert.equal(res.status, 3);
});

test('wait: timeout-min rapido sai 2 e envia aviso de timeout', () => {
  const repo = tempRepo();
  const { scriptPath, logPath } = setupFakeAgentApi();

  runCli([
    'init',
    '--task=Testar timeout',
    '--slug=teste-timeout',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    ...alvo(repo)
  ], repo);

  // Vez do claude, esperamos por gemini com timeout de ~0.02 min (1.2 s)
  const res = runCli([
    'wait',
    '--for=gemini',
    '--timeout-min=0.02',
    '--wake=conv-timeout',
    ...alvo(repo)
  ], repo, {
    BASTAO_POLL_MS: '50',
    BASTAO_AGENTAPI: scriptPath,
    FAKE_LOG: logPath
  });

  assert.equal(res.status, 2);
  assert.match(res.stdout, /TIMEOUT:\s*rearme o wait/i);
  assert.ok(fs.existsSync(logPath));
  const logContent = fs.readFileSync(logPath, 'utf8');
  assert.match(logContent, /tempo esgotado/i);
});

test('wait: lock concorrente sai 4, lock orfao ou antigo e assumido', () => {
  const repo = tempRepo();
  runCli([
    'init',
    '--task=Testar lock',
    '--slug=teste-lock',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    ...alvo(repo)
  ], repo);

  const lock = lockPath(repo, 'gemini');

  // 1. Simula lock ativo com PID atual e mtime recente
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), 'utf8');

  const res = runCli(['wait', '--for=gemini', '--wake=conv-t', ...alvo(repo)], repo, { BASTAO_POLL_MS: '50' });
  assert.equal(res.status, 4, `Esperado 4 para lock ativo, obteve ${res.status}`);

  // 2. Lock com PID inexistente (999999) deve ser assumido
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, started_at: new Date().toISOString() }), 'utf8');
  // Passa para gemini para sair 0
  runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', ...alvo(repo)], repo);
  const res2 = runCli(['wait', '--for=gemini', '--wake=conv-t', ...alvo(repo)], repo, { BASTAO_POLL_MS: '50' });
  assert.equal(res2.status, 0);

  // 3. Lock com PID vivo mas heartbeat antigo (> 30s) deve ser assumido
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), 'utf8');
  const pastTime = new Date(Date.now() - 60000);
  fs.utimesSync(lock, pastTime, pastTime);
  const res3 = runCli(['wait', '--for=gemini', '--wake=conv-t', ...alvo(repo)], repo, { BASTAO_POLL_MS: '50' });
  assert.equal(res3.status, 0);
});

test('wait: falha no agentapi (FAKE_EXIT=1) sai 5 e grava wake_failed no history', () => {
  const repo = tempRepo();
  const { scriptPath } = setupFakeAgentApi();

  runCli([
    'init',
    '--task=Testar falha wake',
    '--slug=teste-wake-fail',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    ...alvo(repo)
  ], repo);

  runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', ...alvo(repo)], repo);

  const res = runCli([
    'wait',
    '--for=gemini',
    '--wake=conv-fail',
    ...alvo(repo)
  ], repo, {
    BASTAO_POLL_MS: '50',
    BASTAO_AGENTAPI: scriptPath,
    FAKE_EXIT: '1'
  });

  assert.equal(res.status, 5);

  const turnPath = estadoPath(repo);
  const state = JSON.parse(fs.readFileSync(turnPath, 'utf8'));
  const lastHistory = state.history[state.history.length - 1];
  assert.equal(lastHistory.action, 'wake_failed');
});

// --- Task 3: Codex por empurrar tests ---

function setupFakeCodex() {
  const tmpDir = fs.mkdtempSync(path.join(ROOT, 'fake-codex-'));
  const scriptPath = path.join(tmpDir, 'fake-codex.mjs');
  const logPath = path.join(tmpDir, 'fake-codex-log.json');
  fs.writeFileSync(scriptPath, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => stdin += chunk);
process.stdin.on('end', () => {
  const log = process.env.FAKE_LOG;
  if (log) {
    fs.writeFileSync(log, JSON.stringify({ argv: process.argv.slice(2), stdin }), 'utf8');
  }
  process.stdout.write('session id: t-123\\n');
  process.stdout.write('codex\\nok ação\\n');

  if (process.env.FAKE_PASS === '1') {
    const cIndex = process.argv.indexOf('-C');
    const repo = cIndex !== -1 ? process.argv[cIndex + 1] : process.cwd();
    spawnSync(process.execPath, [
      process.env.BASTAO_CLI_PATH,
      'pass',
      '--repo=' + repo,
      '--from=codex',
      '--to=claude',
      '--action=review'
    ], { stdio: 'inherit' });
  }

  process.exit(Number(process.env.FAKE_EXIT ?? 0));
});
`, 'utf8');
  return { scriptPath, logPath };
}

test('codex: executa via pass sem thread, captura session id, grava live log', async () => {
  const repo = tempRepo();
  const { scriptPath, logPath } = setupFakeCodex();

  runCli([
    'init',
    '--task=Testar codex sem thread',
    '--slug=teste-codex',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    ...alvo(repo)
  ], repo);

  const notesComAcento = 'Ação com acentuação e aspas "ok"';
  runCli([
    'pass',
    '--from=claude',
    '--to=codex',
    '--action=implement',
    `--notes=${notesComAcento}`,
    ...alvo(repo)
  ], repo, {
    BASTAO_CODEX: scriptPath,
    BASTAO_CLI_PATH: BASTAO_CLI,
    FAKE_LOG: logPath
  });

  // Aguarda até 5s para o processo desanexado do codex rodar
  const start = Date.now();
  let state = null;
  while (Date.now() - start < 5000) {
    await new Promise(r => setTimeout(r, 100));
    try {
      state = JSON.parse(fs.readFileSync(estadoPath(repo), 'utf8'));
      if (state.conversations?.codex === 't-123') break;
    } catch {}
  }

  assert.equal(state.conversations?.codex, 't-123', 'Deve capturar session id t-123');

  assert.ok(fs.existsSync(logPath), 'Log do fake codex deve existir');
  const fakeData = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  assert.ok(fakeData.argv.includes('exec'));
  assert.ok(fakeData.argv.includes('--sandbox'));
  assert.ok(fakeData.argv.includes('workspace-write'));
  assert.ok(fakeData.argv.includes('-C'));
  assert.equal(fakeData.argv[fakeData.argv.indexOf('-C') + 1], path.join(repo, '.worktrees', 'teste-codex'), 'codex roda no worktree');
  assert.ok(fakeData.argv.includes('-'));
  assert.ok(fakeData.stdin.includes('Vez de: codex'));
  assert.ok(fakeData.stdin.includes(notesComAcento));

  // Como FAKE_PASS não foi 1, deve ter ido para WAITING_HUMAN após terminar
  assert.equal(state.status, 'WAITING_HUMAN');
  assert.equal(state.ask_human?.from, 'codex');

  const liveLog = path.join(repo, '.agents', 'live', unicoCiclo(repo), 'codex.log');
  assert.ok(fs.existsSync(liveLog), 'Arquivo live/codex.log deve existir');
  const logContent = fs.readFileSync(liveLog, 'utf8');
  assert.ok(logContent.includes('ok ação'));
});

test('codex: com thread informada resume a thread', async () => {
  const repo = tempRepo();
  const { scriptPath, logPath } = setupFakeCodex();

  runCli([
    'init',
    '--task=Testar codex com thread',
    '--slug=teste-codex-thread',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    '--codex-thread=abc-thread',
    ...alvo(repo)
  ], repo);

  runCli([
    'pass',
    '--from=claude',
    '--to=codex',
    '--action=implement',
    ...alvo(repo)
  ], repo, {
    BASTAO_CODEX: scriptPath,
    BASTAO_CLI_PATH: BASTAO_CLI,
    FAKE_LOG: logPath
  });

  const start = Date.now();
  while (Date.now() - start < 5000) {
    await new Promise(r => setTimeout(r, 100));
    if (fs.existsSync(logPath)) break;
  }

  assert.ok(fs.existsSync(logPath));
  const fakeData = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  const resumeIdx = fakeData.argv.indexOf('resume');
  assert.ok(resumeIdx !== -1);
  assert.equal(fakeData.argv[resumeIdx + 1], 'abc-thread');
});

test('codex: FAKE_PASS=1 passa o bastao para claude', async () => {
  const repo = tempRepo();
  const { scriptPath, logPath } = setupFakeCodex();

  runCli([
    'init',
    '--task=Testar codex pass',
    '--slug=teste-codex-pass',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    ...alvo(repo)
  ], repo);

  runCli([
    'pass',
    '--from=claude',
    '--to=codex',
    '--action=implement',
    ...alvo(repo)
  ], repo, {
    BASTAO_CODEX: scriptPath,
    BASTAO_CLI_PATH: BASTAO_CLI,
    FAKE_LOG: logPath,
    FAKE_PASS: '1'
  });

  const start = Date.now();
  let state = null;
  while (Date.now() - start < 5000) {
    await new Promise(r => setTimeout(r, 100));
    try {
      state = JSON.parse(fs.readFileSync(estadoPath(repo), 'utf8'));
      if (state.current_turn === 'claude' && state.status === 'IN_PROGRESS') break;
    } catch {}
  }

  assert.equal(state.current_turn, 'claude');
  assert.equal(state.status, 'IN_PROGRESS');
});

test('codex: FAKE_EXIT=1 gera ask_human informando exit 1', async () => {
  const repo = tempRepo();
  const { scriptPath, logPath } = setupFakeCodex();

  runCli([
    'init',
    '--task=Testar codex exit 1',
    '--slug=teste-codex-exit',
    '--spec=docs/spec.md',
    '--plan=docs/plan.md',
    ...alvo(repo)
  ], repo);

  runCli([
    'pass',
    '--from=claude',
    '--to=codex',
    '--action=implement',
    ...alvo(repo)
  ], repo, {
    BASTAO_CODEX: scriptPath,
    BASTAO_CLI_PATH: BASTAO_CLI,
    FAKE_LOG: logPath,
    FAKE_EXIT: '1'
  });

  const start = Date.now();
  let state = null;
  while (Date.now() - start < 5000) {
    await new Promise(r => setTimeout(r, 100));
    try {
      state = JSON.parse(fs.readFileSync(estadoPath(repo), 'utf8'));
      if (state.status === 'WAITING_HUMAN') break;
    } catch {}
  }

  assert.equal(state.status, 'WAITING_HUMAN');
  assert.match(state.ask_human?.question, /exit 1/);
});

// --- Task 4: install tests ---

test('install: sem --yes apenas exibe acoes sem alterar nada', () => {
  const fakeHome = fs.mkdtempSync(path.join(ROOT, 'fake-home-'));
  const res = runCli(['install', `--home=${fakeHome}`], fakeHome);
  assert.equal(res.status, 0);

  const claudeSkill = path.join(fakeHome, '.claude', 'skills', 'bastao', 'SKILL.md');
  const geminiSkill = path.join(fakeHome, '.gemini', 'config', 'skills', 'bastao', 'SKILL.md');
  const codexSkill = path.join(fakeHome, '.codex', 'skills', 'bastao', 'SKILL.md');
  const settingsFile = path.join(fakeHome, '.claude', 'settings.json');

  assert.ok(!fs.existsSync(claudeSkill));
  assert.ok(!fs.existsSync(geminiSkill));
  assert.ok(!fs.existsSync(codexSkill));
  assert.ok(!fs.existsSync(settingsFile));
});

test('install: com --yes instala skill nos 3 destinos e atualiza settings.json preservando conteudo sem BOM', () => {
  const fakeHome = fs.mkdtempSync(path.join(ROOT, 'fake-home-'));
  const claudeDir = path.join(fakeHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsFile = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    theme: 'dark',
    permissions: {
      allow: ['Bash(git:*)']
    }
  }, null, 2), 'utf8');

  // 1ª execução com --yes
  let res = runCli(['install', '--yes', `--home=${fakeHome}`], fakeHome);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const claudeSkill = path.join(fakeHome, '.claude', 'skills', 'bastao', 'SKILL.md');
  const geminiSkill = path.join(fakeHome, '.gemini', 'config', 'skills', 'bastao', 'SKILL.md');
  const codexSkill = path.join(fakeHome, '.codex', 'skills', 'bastao', 'SKILL.md');

  assert.ok(fs.existsSync(claudeSkill), 'Skill deve existir no Claude');
  assert.ok(fs.existsSync(geminiSkill), 'Skill deve existir no Gemini');
  assert.ok(fs.existsSync(codexSkill), 'Skill deve existir no Codex');

  let rawSettings = fs.readFileSync(settingsFile);
  assert.equal(rawSettings[0], 0x7B, 'settings.json não deve ter BOM');
  let settings = JSON.parse(rawSettings.toString('utf8'));
  assert.equal(settings.theme, 'dark');
  assert.ok(settings.permissions.allow.includes('Bash(git:*)'));
  assert.ok(settings.permissions.allow.includes('Bash(bastao:*)'));
  assert.ok(settings.permissions.allow.includes('PowerShell(bastao:*)'));

  // 2ª execução com --yes não deve duplicar
  res = runCli(['install', '--yes', `--home=${fakeHome}`], fakeHome);
  assert.equal(res.status, 0);

  rawSettings = fs.readFileSync(settingsFile);
  settings = JSON.parse(rawSettings.toString('utf8'));
  const bashCount = settings.permissions.allow.filter(x => x === 'Bash(bastao:*)').length;
  const psCount = settings.permissions.allow.filter(x => x === 'PowerShell(bastao:*)').length;
  assert.equal(bashCount, 1, 'Não deve duplicar regra Bash');
  assert.equal(psCount, 1, 'Não deve duplicar regra PowerShell');
});

// --- Revisão: caminhos reais que os fakes .mjs não cobriam ---

test('wait: agentapi .bat em pasta com espaço recebe id e texto como argumentos', () => {
  const repo = tempRepo();
  const binDir = path.join(ROOT, `bin com espaço ${Date.now()}`);
  fs.mkdirSync(binDir);
  const logPath = path.join(binDir, 'args.log');
  const bat = path.join(binDir, 'agentapi.bat');
  fs.writeFileSync(bat, '@echo off\r\n>"%~dp0args.log" echo %*\r\n', 'utf8');

  runCli(['init', '--task=t', '--spec=s', '--plan=p', ...alvo(repo)], repo);
  runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', ...alvo(repo)], repo);
  const res = runCli(['wait', '--for=gemini', '--wake=conv-1', ...alvo(repo)], repo, { BASTAO_AGENTAPI: bat });

  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(fs.readFileSync(logPath, 'utf8').trim(),
    'send-message --title=Bastao conv-1 "Bastao: sua vez no ciclo t (pasta com espaco e). Rode: bastao status --ciclo=t e siga a skill bastao."');
});

test('pass e wait recusam agente inválido, flag com typo, wake inválido e repo sem ciclo', () => {
  const repo = tempRepo();
  assert.equal(runCli(['wait', '--for=gemini', ...alvo(repo)], repo).status, 1, 'sem ciclo não fica pendurado');
  runCli(['init', '--task=t', '--spec=s', '--plan=p', ...alvo(repo)], repo);
  const turnPath = estadoPath(repo);
  const before = fs.readFileSync(turnPath);
  assert.equal(runCli(['pass', '--from=claude', '--to=gemni', '--action=implement', ...alvo(repo)], repo).status, 1);
  const typo = runCli(['pass', '--from=claude', '--to=gemini', '--acton=implement', ...alvo(repo)], repo);
  assert.equal(typo.status, 1);
  assert.doesNotMatch(typo.stderr, /^\s+at\s+/m, 'sem stack trace');
  assert.equal(runCli(['wait', '--for=gemini', '--wake=a&b', ...alvo(repo)], repo).status, 1);
  assert.deepEqual(fs.readFileSync(turnPath), before);
});

test('codex: binário inexistente vira WAITING_HUMAN em vez de travar', async () => {
  const repo = tempRepo();
  runCli(['init', '--task=t', '--spec=s', '--plan=p', ...alvo(repo)], repo);
  runCli(['pass', '--from=claude', '--to=codex', '--action=implement', ...alvo(repo)], repo,
    { BASTAO_CODEX: path.join(ROOT, 'nao-existe.exe') });

  let state = null;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    await new Promise(r => setTimeout(r, 100));
    state = JSON.parse(fs.readFileSync(estadoPath(repo), 'utf8'));
    if (state.status === 'WAITING_HUMAN') break;
  }
  assert.equal(state.status, 'WAITING_HUMAN');
  assert.equal(state.ask_human?.from, 'codex');
});

test('install: settings.json com BOM é lido; inválido não é sobrescrito', () => {
  const fakeHome = fs.mkdtempSync(path.join(ROOT, 'fake-home-'));
  const settingsFile = path.join(fakeHome, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });

  fs.writeFileSync(settingsFile, '﻿{"theme":"dark"}', 'utf8');
  assert.equal(runCli(['install', '--yes', `--home=${fakeHome}`], fakeHome).status, 0);
  const raw = fs.readFileSync(settingsFile);
  assert.equal(raw[0], 0x7B);
  assert.equal(JSON.parse(raw.toString('utf8')).theme, 'dark');

  fs.writeFileSync(settingsFile, '{quebrado', 'utf8');
  const res = runCli(['install', '--yes', `--home=${fakeHome}`], fakeHome);
  assert.equal(res.status, 1);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{quebrado');
});



test('--help em subcomando mostra uso e pass repetido é no-op', () => {
  const repo = tempRepo();
  const help = runCli(['init', '--help'], repo);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /init\s+--task=/);

  runCli(['init', '--task=t', '--spec=s', '--plan=p', ...alvo(repo)], repo);
  assert.equal(runCli(['pass', '--from=human', '--to=claude', '--action=plan', '--force', ...alvo(repo)], repo).status, 0);
  const again = runCli(['pass', '--from=human', '--to=claude', '--action=plan', ...alvo(repo)], repo);
  assert.equal(again.status, 0, `stderr: ${again.stderr}`);
  assert.match(again.stdout, /já está com claude/);
  assert.equal(JSON.parse(fs.readFileSync(estadoPath(repo), 'utf8')).history.length, 1);
});

// --- Multiciclo: comandos no ciclo resolvido ---

function doisCiclos() {
  const repo = tempRepo();
  for (const slug of ['a', 'b']) {
    const res = runCli(['init', `--task=${slug}`, `--slug=${slug}`, '--spec=s', '--plan=p', `--repo=${repo}`], repo);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  }
  const estado = slug => path.join(repo, '.agents', 'ciclos', `${slug}.json`);
  return { repo, estado };
}

test('pass em um ciclo não altera o outro e incrementa seq', () => {
  const { repo, estado } = doisCiclos();
  const antesB = fs.readFileSync(estado('b'));
  const res = runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', `--repo=${repo}`, '--ciclo=a'], repo);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const a = JSON.parse(fs.readFileSync(estado('a'), 'utf8'));
  assert.equal(a.current_turn, 'gemini');
  assert.equal(a.seq, 1);
  assert.deepEqual(fs.readFileSync(estado('b')), antesB);
});

test('comando dentro do worktree infere o ciclo sem --ciclo e status mostra ciclo e workspace', () => {
  const { repo, estado } = doisCiclos();
  const sub = path.join(repo, '.worktrees', 'b', 'sub');
  fs.mkdirSync(sub);
  const res = runCli(['pass', '--from=claude', '--to=gemini', '--action=implement'], sub);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(estado('b'), 'utf8')).current_turn, 'gemini');
  assert.equal(JSON.parse(fs.readFileSync(estado('a'), 'utf8')).current_turn, 'claude');
  const st = runCli(['status'], sub);
  assert.equal(st.status, 0, `stderr: ${st.stderr}`);
  assert.match(st.stdout, /Ciclo: b \(pasta com espaço é\)/);
  assert.ok(st.stdout.includes(`Workspace: ${path.join(repo, '.worktrees', 'b')}`));
});

test('na pasta principal pass e wait exigem --ciclo; status lista os ciclos', () => {
  const repo = tempRepo();
  runCli(['init', '--task=a', '--slug=a', '--spec=s', '--plan=p', `--repo=${repo}`], repo);
  const pass = runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', `--repo=${repo}`], repo);
  assert.equal(pass.status, 1);
  assert.match(pass.stderr, /--ciclo=a/);
  assert.match(pass.stderr, /\.worktrees/);
  const wait = runCli(['wait', '--for=claude', '--timeout-min=0.001', `--repo=${repo}`], repo);
  assert.equal(wait.status, 1);
  assert.match(wait.stderr, /--ciclo=a/);

  runCli(['init', '--task=b', '--slug=b', '--spec=s', '--plan=p', `--repo=${repo}`], repo);
  const st = runCli(['status', `--repo=${repo}`], repo);
  assert.equal(st.status, 0, `stderr: ${st.stderr}`);
  assert.match(st.stdout, /^a · vez de claude · spec · IN_PROGRESS/m);
  assert.match(st.stdout, /^b · vez de claude · spec · IN_PROGRESS/m);
});

test('legado: turn.json segue funcionando com lock antigo ao lado de um ciclo novo', () => {
  const repo = tempRepo();
  runCli(['init', '--task=novo', '--slug=novo', '--spec=s', '--plan=p', `--repo=${repo}`], repo);
  const turn = path.join(repo, '.agents', 'turn.json');
  fs.writeFileSync(turn, JSON.stringify({
    version: 2, task: 'leg', slug: 'leg', branch: 'ai/leg', spec_file: 's', plan_file: 'p',
    roles: { implement: 'gemini', review: ['claude'] }, conversations: { gemini: null, codex: null },
    current_turn: 'claude', action: 'spec', status: 'IN_PROGRESS', round: 1, max_rounds: 3,
    active_skills: [], notes: '', last_evidence: null, ask_human: null, history: []
  }));
  const res = runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', `--repo=${repo}`, '--ciclo=leg'], repo);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const leg = JSON.parse(fs.readFileSync(turn, 'utf8'));
  assert.equal(leg.current_turn, 'gemini');
  assert.equal(leg.seq, 1);
  assert.equal(leg.worktree, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'ciclos', 'novo.json'), 'utf8')).current_turn, 'claude');

  fs.writeFileSync(path.join(repo, '.agents', 'wait-claude.lock'), JSON.stringify({ pid: process.pid }));
  const wait = runCli(['wait', '--for=claude', `--repo=${repo}`, '--ciclo=leg'], repo, { BASTAO_POLL_MS: '50' });
  assert.equal(wait.status, 4, 'vigia legado vivo é respeitado');
});

// --- Multiciclo: acordar o Gemini ---

test('wakeText: texto exato, reacordar e caminho omitido quando não é seguro', () => {
  const st = { slug: 'w' };
  assert.equal(wakeText(st, { repoName: 'GESTAO', worktreeAbs: String.raw`C:\r\GESTAO\.worktrees\w` }),
    String.raw`Bastao: sua vez no ciclo w (GESTAO). Workspace: C:\r\GESTAO\.worktrees\w. Rode: bastao status --ciclo=w e siga a skill bastao.`);
  assert.equal(wakeText(st, { repoName: 'GESTAO', worktreeAbs: null, rewake: true }),
    'Bastao: sua vez no ciclo w (GESTAO). Rode: bastao status --ciclo=w e siga a skill bastao. Se ja estiver trabalhando, ignore.');
  for (const ruim of [String.raw`C:\a&b\.worktrees\w`, String.raw`C:\100%\w`, String.raw`C:\pasta é\w`]) {
    assert.doesNotMatch(wakeText(st, { repoName: 'R', worktreeAbs: ruim }), /Workspace/);
  }
  assert.doesNotMatch(wakeText(st, { repoName: 'Produção & cia' }), /[^\x20-\x7e]|[&|<>^"%]/);
});

function cicloComGemini(slug, conversa) {
  const repo = tempRepo();
  runCli(['init', `--task=${slug}`, `--slug=${slug}`, '--spec=s', '--plan=p', `--repo=${repo}`], repo);
  const file = path.join(repo, '.agents', 'ciclos', `${slug}.json`);
  if (conversa) {
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    st.conversations.gemini = conversa;
    fs.writeFileSync(file, JSON.stringify(st));
  }
  return { repo, file };
}

test('pass para gemini com conversa registrada acorda na hora', () => {
  const { repo, file } = cicloComGemini('w', 'conv-1');
  const { scriptPath, logPath } = setupFakeAgentApi();
  const res = runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', `--repo=${repo}`, '--ciclo=w'], repo,
    { BASTAO_AGENTAPI: scriptPath, FAKE_LOG: logPath });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const [args] = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(args, ['send-message', '--title=Bastao', 'conv-1',
    'Bastao: sua vez no ciclo w (pasta com espaco e). Rode: bastao status --ciclo=w e siga a skill bastao.']);
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(st.wake.seq, st.seq);
  assert.equal(st.wake.ok, true);
  assert.equal(st.history.at(-1).action, 'wake');
});

test('pass para gemini sem conversa registrada avisa o usuário', () => {
  const { repo } = cicloComGemini('semconv', null);
  const aviso = path.join(ROOT, `aviso-${Date.now()}.log`);
  const res = runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', `--repo=${repo}`, '--ciclo=semconv'], repo,
    { BASTAO_NOTIFY: aviso });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const texto = fs.readFileSync(aviso, 'utf8');
  assert.match(texto, /pasta com espaço é\/semconv/);
  assert.match(texto, /retome o bastão semconv/);
});

test('vigia do gemini não reenvia na passagem já acordada pelo pass', () => {
  const { repo } = cicloComGemini('dup', 'conv-1');
  const { scriptPath, logPath } = setupFakeAgentApi();
  const env = { BASTAO_AGENTAPI: scriptPath, FAKE_LOG: logPath, BASTAO_POLL_MS: '50' };
  runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', `--repo=${repo}`, '--ciclo=dup'], repo, env);
  const res = runCli(['wait', '--for=gemini', '--wake=conv-1', `--repo=${repo}`, '--ciclo=dup'], repo, env);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 1);
});

test('wait --for=gemini sem --wake falha', () => {
  const { repo } = cicloComGemini('semwake', null);
  const res = runCli(['wait', '--for=gemini', `--repo=${repo}`, '--ciclo=semwake'], repo, { BASTAO_POLL_MS: '50' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--wake/);
});
