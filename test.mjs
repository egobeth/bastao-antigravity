import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
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

// --- Task 2: wait, lock e wake tests ---

function setupFakeAgentApi() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-agentapi-'));
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
    `--repo=${repo}`
  ], repo);

  // claude passa para gemini
  runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', `--repo=${repo}`], repo);

  const start = Date.now();
  const res = runCli(['wait', '--for=gemini', `--repo=${repo}`], repo, { BASTAO_POLL_MS: '50' });
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
    `--repo=${repo}`
  ], repo);

  const geminiId = 'conv-123-gemini';
  const waitProc = spawn(process.execPath, [
    BASTAO_CLI,
    'wait',
    '--for=gemini',
    `--wake=${geminiId}`,
    `--repo=${repo}`
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
  runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', `--repo=${repo}`], repo);

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
    `--repo=${repo}`
  ], repo);

  // Leva a APPROVED
  runCli(['pass', '--from=claude', '--to=human', '--action=done', `--repo=${repo}`], repo);

  const res = runCli(['wait', '--for=claude', `--repo=${repo}`], repo, { BASTAO_POLL_MS: '50' });
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
    `--repo=${repo}`
  ], repo);

  // Vez do claude, esperamos por gemini com timeout de ~0.02 min (1.2 s)
  const res = runCli([
    'wait',
    '--for=gemini',
    '--timeout-min=0.02',
    '--wake=conv-timeout',
    `--repo=${repo}`
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
    `--repo=${repo}`
  ], repo);

  const lockPath = path.join(repo, '.agents', 'wait-gemini.lock');

  // 1. Simula lock ativo com PID atual e mtime recente
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), 'utf8');

  const res = runCli(['wait', '--for=gemini', `--repo=${repo}`], repo, { BASTAO_POLL_MS: '50' });
  assert.equal(res.status, 4, `Esperado 4 para lock ativo, obteve ${res.status}`);

  // 2. Lock com PID inexistente (999999) deve ser assumido
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, started_at: new Date().toISOString() }), 'utf8');
  // Passa para gemini para sair 0
  runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', `--repo=${repo}`], repo);
  const res2 = runCli(['wait', '--for=gemini', `--repo=${repo}`], repo, { BASTAO_POLL_MS: '50' });
  assert.equal(res2.status, 0);

  // 3. Lock com PID vivo mas heartbeat antigo (> 30s) deve ser assumido
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), 'utf8');
  const pastTime = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, pastTime, pastTime);
  const res3 = runCli(['wait', '--for=gemini', `--repo=${repo}`], repo, { BASTAO_POLL_MS: '50' });
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
    `--repo=${repo}`
  ], repo);

  runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', `--repo=${repo}`], repo);

  const res = runCli([
    'wait',
    '--for=gemini',
    '--wake=conv-fail',
    `--repo=${repo}`
  ], repo, {
    BASTAO_POLL_MS: '50',
    BASTAO_AGENTAPI: scriptPath,
    FAKE_EXIT: '1'
  });

  assert.equal(res.status, 5);

  const turnPath = path.join(repo, '.agents', 'turn.json');
  const state = JSON.parse(fs.readFileSync(turnPath, 'utf8'));
  const lastHistory = state.history[state.history.length - 1];
  assert.equal(lastHistory.action, 'wake_failed');
});

// --- Task 3: Codex por empurrar tests ---

function setupFakeCodex() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-'));
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
    `--repo=${repo}`
  ], repo);

  const notesComAcento = 'Ação com acentuação e aspas "ok"';
  runCli([
    'pass',
    '--from=claude',
    '--to=codex',
    '--action=implement',
    `--notes=${notesComAcento}`,
    `--repo=${repo}`
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
      state = JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'turn.json'), 'utf8'));
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
  assert.ok(fakeData.argv.includes('-'));
  assert.ok(fakeData.stdin.includes('Vez de: codex'));
  assert.ok(fakeData.stdin.includes(notesComAcento));

  // Como FAKE_PASS não foi 1, deve ter ido para WAITING_HUMAN após terminar
  assert.equal(state.status, 'WAITING_HUMAN');
  assert.equal(state.ask_human?.from, 'codex');

  const liveLog = path.join(repo, '.agents', 'live', 'codex.log');
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
    `--repo=${repo}`
  ], repo);

  runCli([
    'pass',
    '--from=claude',
    '--to=codex',
    '--action=implement',
    `--repo=${repo}`
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
    `--repo=${repo}`
  ], repo);

  runCli([
    'pass',
    '--from=claude',
    '--to=codex',
    '--action=implement',
    `--repo=${repo}`
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
      state = JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'turn.json'), 'utf8'));
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
    `--repo=${repo}`
  ], repo);

  runCli([
    'pass',
    '--from=claude',
    '--to=codex',
    '--action=implement',
    `--repo=${repo}`
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
      state = JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'turn.json'), 'utf8'));
      if (state.status === 'WAITING_HUMAN') break;
    } catch {}
  }

  assert.equal(state.status, 'WAITING_HUMAN');
  assert.match(state.ask_human?.question, /exit 1/);
});


