import test, { after } from 'node:test';
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bastao-teste-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }));

process.env.BASTAO_NOTIFY = 'off';

function runCli(args, cwd, env = {}) {
  return spawnSync(process.execPath, [BASTAO_CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BASTAO_NOTIFY: 'off', ...env }
  });
}

function tempRepo() {
  const base = path.join(ROOT, `bastao-teste-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// --- Task 4: install tests ---

test('install: sem --yes apenas exibe acoes sem alterar nada', () => {
  const fakeHome = fs.mkdtempSync(path.join(ROOT, 'fake-home-'));
  const res = runCli(['install', `--home=${fakeHome}`], fakeHome);
  assert.equal(res.status, 0);

  const claudeSkill = path.join(fakeHome, '.claude', 'skills', 'bastao', 'SKILL.md');
  const geminiSkill = path.join(fakeHome, '.gemini', 'antigravity', 'skills', 'bastao', 'SKILL.md');
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
  const geminiSkill = path.join(fakeHome, '.gemini', 'antigravity', 'skills', 'bastao', 'SKILL.md');
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

  runCli(['init', '--task=t', '--spec=s', '--plan=p', `--repo=${repo}`], repo);
  runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', `--repo=${repo}`], repo);
  const res = runCli(['wait', '--for=gemini', '--wake=conv-1', `--repo=${repo}`], repo, { BASTAO_AGENTAPI: bat });

  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(fs.readFileSync(logPath, 'utf8').trim(),
    'send-message --title=Bastao conv-1 "Bastao: sua vez. Rode: bastao status  e siga a skill bastao."');
});

test('pass e wait recusam agente inválido, flag com typo, wake inválido e repo sem ciclo', () => {
  const repo = tempRepo();
  assert.equal(runCli(['wait', '--for=gemini', `--repo=${repo}`], repo).status, 1, 'sem ciclo não fica pendurado');
  runCli(['init', '--task=t', '--spec=s', '--plan=p', `--repo=${repo}`], repo);
  const turnPath = path.join(repo, '.agents', 'turn.json');
  const before = fs.readFileSync(turnPath);
  assert.equal(runCli(['pass', '--from=claude', '--to=gemni', '--action=implement', `--repo=${repo}`], repo).status, 1);
  const typo = runCli(['pass', '--from=claude', '--to=gemini', '--acton=implement', `--repo=${repo}`], repo);
  assert.equal(typo.status, 1);
  assert.doesNotMatch(typo.stderr, /^\s+at\s+/m, 'sem stack trace');
  assert.equal(runCli(['wait', '--for=gemini', '--wake=a&b', `--repo=${repo}`], repo).status, 1);
  assert.deepEqual(fs.readFileSync(turnPath), before);
});

test('codex: binário inexistente vira WAITING_HUMAN em vez de travar', async () => {
  const repo = tempRepo();
  runCli(['init', '--task=t', '--spec=s', '--plan=p', `--repo=${repo}`], repo);
  runCli(['pass', '--from=claude', '--to=codex', '--action=implement', `--repo=${repo}`], repo,
    { BASTAO_CODEX: path.join(ROOT, 'nao-existe.exe') });

  let state = null;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    await new Promise(r => setTimeout(r, 100));
    state = JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'turn.json'), 'utf8'));
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

  runCli(['init', '--task=t', '--spec=s', '--plan=p', `--repo=${repo}`], repo);
  assert.equal(runCli(['pass', '--from=human', '--to=claude', '--action=plan', '--force', `--repo=${repo}`], repo).status, 0);
  const again = runCli(['pass', '--from=human', '--to=claude', '--action=plan', `--repo=${repo}`], repo);
  assert.equal(again.status, 0, `stderr: ${again.stderr}`);
  assert.match(again.stdout, /já está com claude/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'turn.json'), 'utf8')).history.length, 1);
});
