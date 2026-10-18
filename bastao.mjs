import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';

export class BastaoError extends Error {
  constructor(message, code = 'GENERIC') {
    super(message);
    this.name = 'BastaoError';
    this.code = code;
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export const AGENTS = ['claude', 'gemini', 'codex', 'human'];

export function parseRoles(str) {
  if (!str || typeof str !== 'string') return null;
  const res = { implement: 'gemini', review: ['claude'] };
  const parts = str.split(',');
  for (const part of parts) {
    const [k, v] = part.split(':').map(s => s && s.trim());
    if (k === 'implement' && v) {
      res.implement = v;
    } else if (k === 'review' && v) {
      res.review = v.split('+').map(s => s.trim()).filter(Boolean);
    }
  }
  return res;
}

export function initState({
  task,
  slug,
  spec,
  plan,
  implement = 'gemini',
  review = ['claude'],
  maxRounds = 3,
  codexThread = null
}, now = new Date().toISOString()) {
  const reviewList = Array.isArray(review) ? review : [review];
  const stateSlug = slug || (task ? task.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'ciclo');
  return {
    version: 2,
    task,
    slug: stateSlug,
    branch: `ai/${stateSlug}`,
    spec_file: spec,
    plan_file: plan,
    roles: {
      implement,
      review: reviewList
    },
    conversations: {
      gemini: null,
      codex: codexThread || null
    },
    current_turn: 'claude',
    action: 'spec',
    status: 'IN_PROGRESS',
    round: 1,
    max_rounds: Number(maxRounds) || 3,
    active_skills: ['ponytail', 'test-driven-development'],
    notes: '',
    last_evidence: null,
    ask_human: null,
    history: []
  };
}

export function applyPass(state, {
  from,
  to,
  action,
  notes = '',
  evidence = null,
  skills = null,
  roles = null,
  force = false
}, now = new Date().toISOString()) {
  for (const who of [from, to]) {
    if (!AGENTS.includes(who)) throw new BastaoError(`Agente inválido: ${who} (use ${AGENTS.join(', ')})`, 'INVALID_ARGS');
  }
  if (!force) {
    if (state.status === 'WAITING_HUMAN') {
      const allowedFrom = state.ask_human?.from;
      if (allowedFrom && from !== allowedFrom) {
        throw new BastaoError(`Apenas quem perguntou (${allowedFrom}) pode passar o bastão durante WAITING_HUMAN`, 'NOT_YOUR_TURN');
      }
    } else if (['APPROVED', 'MANUAL_PAUSE', 'MAX_ROUNDS_REACHED'].includes(state.status)) {
      if (from !== 'human') {
        throw new BastaoError(`Em status ${state.status}, apenas human pode passar o bastão`, 'NOT_YOUR_TURN');
      }
    } else {
      if (from !== state.current_turn) {
        throw new BastaoError(`Não é a sua vez (vez atual: ${state.current_turn})`, 'NOT_YOUR_TURN');
      }
    }
  }

  let newTurn = to;
  let newStatus = 'IN_PROGRESS';
  let newRound = state.round;

  if (action === 'done') {
    if (to !== 'human') {
      throw new BastaoError("Ação 'done' exige --to=human", 'INVALID_ACTION');
    }
    newStatus = 'APPROVED';
    newTurn = 'human';
  } else if (action === 'fix') {
    newRound = state.round + 1;
    if (newRound > state.max_rounds) {
      newTurn = 'human';
      newStatus = 'MAX_ROUNDS_REACHED';
    } else {
      newTurn = to;
      newStatus = 'IN_PROGRESS';
    }
  } else {
    newTurn = to;
    newStatus = 'IN_PROGRESS';
  }

  const s = JSON.parse(JSON.stringify(state));
  s.current_turn = newTurn;
  s.status = newStatus;
  s.round = newRound;
  s.action = action;
  s.notes = notes;
  if (evidence !== null && evidence !== undefined) s.last_evidence = evidence;
  if (skills) {
    s.active_skills = Array.isArray(skills) ? skills : skills.split(',').map(x => x.trim()).filter(Boolean);
  }
  if (roles) {
    s.roles = typeof roles === 'string' ? parseRoles(roles) : roles;
  }
  s.ask_human = null;

  s.history.push({
    at: now,
    from,
    to: newTurn,
    action,
    round: newRound,
    notes,
    evidence: evidence || null
  });

  let notify = null;
  if (newTurn === 'human') {
    if (newStatus === 'APPROVED') {
      notify = `[APROVADO] ${s.slug}: pronto para merge em ${s.branch}`;
    } else if (newStatus === 'MAX_ROUNDS_REACHED') {
      notify = `[LIMITE DE RODADAS] ${s.slug}: decida no chat`;
    } else {
      notify = `[BASTAO] ${s.slug}: vez de human`;
    }
  }

  return { state: s, notify };
}

export function applyAsk(state, { from, question }, now = new Date().toISOString()) {
  if (from !== state.current_turn) {
    throw new BastaoError(`Não é a sua vez (vez atual: ${state.current_turn})`, 'NOT_YOUR_TURN');
  }

  const s = JSON.parse(JSON.stringify(state));
  s.status = 'WAITING_HUMAN';
  s.ask_human = { from, question, at: now };
  s.history.push({
    at: now,
    from,
    to: 'human',
    action: 'ask',
    round: s.round,
    notes: question,
    evidence: null
  });

  const notify = `[DÚVIDA] ${from}: ${question}`;
  return { state: s, notify };
}

export function applyPause(state, now = new Date().toISOString()) {
  const s = JSON.parse(JSON.stringify(state));
  s.status = 'MANUAL_PAUSE';
  s.current_turn = 'human';
  s.history.push({
    at: now,
    from: state.current_turn,
    to: 'human',
    action: 'pause',
    round: s.round,
    notes: 'Pausa manual',
    evidence: null
  });
  return { state: s, notify: null };
}

export function formatInstructions(state) {
  const rolesStr = state.roles
    ? `implement:${state.roles.implement}, review:${(state.roles.review || []).join('+')}`
    : '';
  return [
    `Vez de: ${state.current_turn}`,
    `Ação: ${state.action}`,
    `Round: ${state.round}/${state.max_rounds}`,
    `Notas: ${state.notes || ''}`,
    `Spec: ${state.spec_file}`,
    `Plano: ${state.plan_file}`,
    `Última evidência: ${state.last_evidence || '(nenhuma)'}`,
    `Skills: ${(state.active_skills || []).join(', ')}`,
    `Papéis: ${rolesStr}`,
    `Ao terminar: bastao pass --from=${state.current_turn} …`
  ].join('\n');
}

export function resolveRepo(arg, cwd = process.cwd()) {
  const targetDir = arg ? path.resolve(cwd, arg) : cwd;
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: targetDir,
    encoding: 'utf8'
  });
  if (res.status !== 0 || !res.stdout) {
    throw new BastaoError('Diretório não é um repositório git', 'NOT_GIT');
  }
  return path.normalize(res.stdout.trim());
}

export async function readState(repo) {
  const turnPath = path.join(repo, '.agents', 'turn.json');
  if (!fs.existsSync(turnPath)) return null;

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const raw = fs.readFileSync(turnPath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new BastaoError(`turn.json inválido em ${turnPath}`, 'CORRUPT_STATE');
      }
      lastErr = err;
      if (attempt < 3) await sleep(200);
    }
  }
  throw lastErr;
}

export function writeState(repo, state) {
  const agentsDir = path.join(repo, '.agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const tmpPath = path.join(agentsDir, 'turn.json.tmp');
  const targetPath = path.join(agentsDir, 'turn.json');
  const data = JSON.stringify(state, null, 2) + '\n';
  fs.writeFileSync(tmpPath, data, 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

export function ensureExclude(repo) {
  const excludePath = path.join(repo, '.git', 'info', 'exclude');
  const dir = path.dirname(excludePath);
  fs.mkdirSync(dir, { recursive: true });
  let content = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  const linesToAdd = [
    '.agents/turn.json',
    '.agents/turn.json.tmp',
    '.agents/*.lock',
    '.agents/live/'
  ];
  const existing = new Set(content.split(/\r?\n/).map(l => l.trim()));
  const missing = linesToAdd.filter(l => !existing.has(l));
  if (missing.length > 0) {
    if (content && !content.endsWith('\n')) content += '\n';
    content += missing.join('\n') + '\n';
    fs.writeFileSync(excludePath, content, 'utf8');
  }
}

export function sendAgentApiMessage(wakeId, text) {
  const bin = process.env.BASTAO_AGENTAPI
    || path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity-ide', 'bin', 'agentapi.bat');
  if (bin.endsWith('.mjs')) {
    return spawnSync(process.execPath, [bin, 'send-message', '--title=Bastao', wakeId, text], { windowsHide: true }).status === 0;
  }
  // cmd /s /c remove o primeiro e o último ", por isso a linha inteira vai entre aspas e sem o escape do libuv.
  // wakeId é validado no wait e o texto é fixo (sem & | < > ^ " %).
  const res = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${bin}" send-message --title=Bastao ${wakeId} "${text}""`], {
    windowsHide: true,
    windowsVerbatimArguments: true
  });
  return res.status === 0;
}

export function isLockAlive(lockPath) {
  if (!fs.existsSync(lockPath)) return false;
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > 30000) {
      return false;
    }
    const raw = fs.readFileSync(lockPath, 'utf8');
    const data = JSON.parse(raw);
    const pid = Number(data.pid);
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  } catch {
    return false;
  }
}

export function findCodex() {
  if (process.env.BASTAO_CODEX) {
    return process.env.BASTAO_CODEX;
  }

  const whereRes = spawnSync('where', ['codex'], { encoding: 'utf8' });
  if (whereRes.status === 0 && whereRes.stdout) {
    const firstPath = whereRes.stdout.trim().split(/\r?\n/)[0].trim();
    if (firstPath) return firstPath;
  }

  const userProfile = process.env.USERPROFILE || '';
  const extensionsDir = path.join(userProfile, '.antigravity-ide', 'extensions');
  if (fs.existsSync(extensionsDir)) {
    try {
      const dirs = fs.readdirSync(extensionsDir)
        .filter(name => name.startsWith('openai.chatgpt-'))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const d of dirs) {
        const candidate = path.join(extensionsDir, d, 'bin', 'windows-x86_64', 'codex.exe');
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    } catch {}
  }

  throw new BastaoError('Codex não encontrado', 'CODEX_NOT_FOUND');
}

export function notify(text) {
  if (process.env.BASTAO_NOTIFY === 'off') return;
  const username = process.env.USERNAME || process.env.USER || '';
  if (username) {
    const res = spawnSync('msg', [username, '/TIME:0', text], {
      stdio: 'ignore',
      windowsHide: true
    });
    if (res.status === 0) return;
  }
  process.stdout.write('\x07');
}

export async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);

  if (!command || ['--help', '-h', 'help'].includes(command) || rest.includes('--help') || rest.includes('-h')) {
    console.log(`Uso: bastao <comando> [opções]
  status
  init    --task= --spec= --plan= [--slug=] [--implement=gemini] [--review=claude,codex] [--max-rounds=3] [--codex-thread=] [--force]
  pass    --from= --to= --action= [--notes=] [--evidence=] [--skills=a,b] [--roles=implement:x,review:y+z] [--force]
  ask     --from= --question=
  pause
  wait    --for=<claude|gemini|codex> [--wake=<id>] [--timeout-min=240]
  install [--yes]
Todos aceitam --repo=<dir>. Ciclo já existe? Use 'status' e 'pass', não 'init'.`);
    return;
  }

  if (command === 'install') {
    const { values } = parseArgs({
      args: rest,
      options: {
        yes: { type: 'boolean', default: false },
        home: { type: 'string' }
      },
      allowPositionals: true,
      strict: true
    });

    const home = values.home || process.env.USERPROFILE || process.env.HOME || '';
    const isDryRun = !values.yes;

    console.log(`bastao install: ${isDryRun ? '[SIMULAÇÃO - use --yes para aplicar]' : '[EXECUTANDO]'}`);

    const agentApiBat = path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity-ide', 'bin', 'agentapi.bat');
    const agentApiOk = fs.existsSync(agentApiBat);
    console.log(`  agentapi.bat: ${agentApiOk ? '✓' : '✗'} (${agentApiBat})`);

    let codexPath = null;
    try {
      codexPath = findCodex();
      console.log(`  findCodex: ✓ (${codexPath})`);
    } catch {
      console.log('  findCodex: ✗ (não encontrado)');
    }

    const currentFile = fileURLToPath(import.meta.url);
    const skillSource = path.join(path.dirname(currentFile), 'SKILL.md');
    const destinations = [
      path.join(home, '.claude', 'skills', 'bastao', 'SKILL.md'),
      path.join(home, '.gemini', 'config', 'skills', 'bastao', 'SKILL.md'),
      path.join(home, '.codex', 'skills', 'bastao', 'SKILL.md')
    ];

    for (const dst of destinations) {
      if (isDryRun) {
        console.log(`  [dry-run] Copiaria SKILL.md para ${dst}`);
      } else {
        if (fs.existsSync(skillSource)) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(skillSource, dst);
          console.log(`  ✓ Instalada skill em ${dst}`);
        } else {
          console.warn(`  ✗ Arquivo fonte da skill não encontrado: ${skillSource}`);
        }
      }
    }

    const claudeSettingsFile = path.join(home, '.claude', 'settings.json');
    if (isDryRun) {
      console.log(`  [dry-run] Adicionaria Bash(bastao:*) e PowerShell(bastao:*) em ${claudeSettingsFile}`);
    } else {
      let settings = {};
      if (fs.existsSync(claudeSettingsFile)) {
        try {
          settings = JSON.parse(fs.readFileSync(claudeSettingsFile, 'utf8').replace(/^﻿/, ''));
        } catch {
          throw new BastaoError(`settings.json inválido em ${claudeSettingsFile}; corrija-o antes (nada foi alterado nele)`, 'CORRUPT_SETTINGS');
        }
      }
      settings.permissions = settings.permissions || {};
      settings.permissions.allow = settings.permissions.allow || [];
      const rules = ['Bash(bastao:*)', 'PowerShell(bastao:*)'];
      for (const rule of rules) {
        if (!settings.permissions.allow.includes(rule)) {
          settings.permissions.allow.push(rule);
        }
      }
      fs.mkdirSync(path.dirname(claudeSettingsFile), { recursive: true });
      fs.writeFileSync(claudeSettingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
      console.log(`  ✓ Permissões configuradas em ${claudeSettingsFile}`);
    }

    if (!isDryRun && !values.home) {
      const toolDir = path.dirname(currentFile);
      const psCmd = `
        $cur = [Environment]::GetEnvironmentVariable('Path', 'User')
        $target = '${toolDir.replace(/'/g, "''")}'
        if ($cur -notlike "*$target*") {
          $new = if ($cur) { "$cur;$target" } else { $target }
          [Environment]::SetEnvironmentVariable('Path', $new, 'User')
        }
      `;
      const ps = spawnSync('powershell', ['-NoProfile', '-Command', psCmd], { windowsHide: true });
      console.log(ps.status === 0
        ? `  ✓ Adicionado ao PATH do usuário: ${toolDir}`
        : `  ✗ Não foi possível atualizar o PATH do usuário: ${toolDir}`);
    } else if (isDryRun && !values.home) {
      const toolDir = path.dirname(currentFile);
      console.log(`  [dry-run] Adicionaria ao PATH do usuário: ${toolDir}`);
    }

    return;
  }

  const repoArgIndex = rest.findIndex(a => a.startsWith('--repo=') || a === '--repo');
  let repoPath = null;
  if (repoArgIndex !== -1) {
    if (rest[repoArgIndex].startsWith('--repo=')) {
      repoPath = rest[repoArgIndex].slice('--repo='.length);
    } else if (rest[repoArgIndex + 1]) {
      repoPath = rest[repoArgIndex + 1];
    }
  }

  const repo = resolveRepo(repoPath, process.cwd());

  if (command === 'init') {
    const { values } = parseArgs({
      args: rest,
      options: {
        task: { type: 'string' },
        slug: { type: 'string' },
        spec: { type: 'string' },
        plan: { type: 'string' },
        implement: { type: 'string', default: 'gemini' },
        review: { type: 'string', default: 'claude' },
        'max-rounds': { type: 'string', default: '3' },
        'codex-thread': { type: 'string' },
        force: { type: 'boolean', default: false },
        repo: { type: 'string' }
      },
      allowPositionals: true,
      strict: true
    });

    if (!values.task || !values.spec || !values.plan) {
      throw new BastaoError('Comando init exige --task, --spec e --plan', 'INVALID_ARGS');
    }

    const current = await readState(repo);
    if (current && !values.force) {
      throw new BastaoError('Já existe um ciclo ativo neste repositório. Use --force para sobrescrever.', 'ACTIVE_CYCLE');
    }

    ensureExclude(repo);

    const reviewList = values.review ? values.review.split(',').map(s => s.trim()).filter(Boolean) : ['claude'];
    const state = initState({
      task: values.task,
      slug: values.slug,
      spec: values.spec,
      plan: values.plan,
      implement: values.implement,
      review: reviewList,
      maxRounds: Number(values['max-rounds']) || 3,
      codexThread: values['codex-thread'] || null
    });

    writeState(repo, state);
    console.log(`bastao: ciclo iniciado para '${state.slug}' (vez de ${state.current_turn})`);
    return;
  }

  if (command === 'pass') {
    const { values } = parseArgs({
      args: rest,
      options: {
        from: { type: 'string' },
        to: { type: 'string' },
        action: { type: 'string' },
        notes: { type: 'string', default: '' },
        evidence: { type: 'string' },
        skills: { type: 'string' },
        roles: { type: 'string' },
        force: { type: 'boolean', default: false },
        repo: { type: 'string' }
      },
      allowPositionals: true,
      strict: true
    });

    if (!values.from) throw new BastaoError('Comando pass exige --from', 'INVALID_ARGS');
    if (!values.to) throw new BastaoError('Comando pass exige --to', 'INVALID_ARGS');
    if (!values.action) throw new BastaoError('Comando pass exige --action', 'INVALID_ARGS');

    const state = await readState(repo);
    if (!state) throw new BastaoError('Nenhum ciclo ativo neste repositório', 'NO_CYCLE');

    // Repetir um pass que já foi aplicado não é erro: evita o "Não é a sua vez" que faz o agente tentar de novo.
    if (!values.force && state.status === 'IN_PROGRESS' && values.from !== state.current_turn
      && state.current_turn === values.to && state.action === values.action) {
      console.log(`bastao: o bastão já está com ${state.current_turn} (${state.action}); nada a fazer`);
      return;
    }

    const { state: nextState, notify: notifyMsg } = applyPass(state, {
      from: values.from,
      to: values.to,
      action: values.action,
      notes: values.notes || '',
      evidence: values.evidence || null,
      skills: values.skills || null,
      roles: values.roles || null,
      force: values.force || false
    });

    writeState(repo, nextState);
    if (notifyMsg) notify(notifyMsg);
    console.log(`bastao: bastão passado para ${nextState.current_turn} (${nextState.action})`);

    if (nextState.current_turn === 'codex' && nextState.status === 'IN_PROGRESS') {
      const bastaoScript = fileURLToPath(import.meta.url);
      const child = spawn(process.execPath, [bastaoScript, '_codex', `--repo=${repo}`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env
      });
      child.unref();
    }
    return;
  }

  if (command === 'ask') {
    const { values } = parseArgs({
      args: rest,
      options: {
        from: { type: 'string' },
        question: { type: 'string' },
        repo: { type: 'string' }
      },
      allowPositionals: true,
      strict: true
    });

    if (!values.from || !values.question) {
      throw new BastaoError('Comando ask exige --from e --question', 'INVALID_ARGS');
    }

    const state = await readState(repo);
    if (!state) throw new BastaoError('Nenhum ciclo ativo neste repositório', 'NO_CYCLE');

    const { state: nextState, notify: notifyMsg } = applyAsk(state, {
      from: values.from,
      question: values.question
    });

    writeState(repo, nextState);
    if (notifyMsg) notify(notifyMsg);
    console.log(`bastao: dúvida registrada. Aguardando resposta humana.`);
    return;
  }

  if (command === 'pause') {
    const state = await readState(repo);
    if (!state) throw new BastaoError('Nenhum ciclo ativo neste repositório', 'NO_CYCLE');

    const { state: nextState } = applyPause(state);
    writeState(repo, nextState);
    console.log('bastao: ciclo pausado manualmente (vez de human)');
    return;
  }

  if (command === 'status') {
    const state = await readState(repo);
    if (!state) {
      console.log('bastao: nenhum ciclo ativo');
      return;
    }

    console.log(formatInstructions(state));
    console.log('\nHistórico recente:');
    const recent = (state.history || []).slice(-5);
    if (recent.length === 0) {
      console.log('  (nenhum evento)');
    } else {
      for (const h of recent) {
        console.log(`  [${h.at}] ${h.from} -> ${h.to} (${h.action}) r${h.round}: ${h.notes || ''}`);
      }
    }
    return;
  }

  if (command === 'wait') {
    const { values } = parseArgs({
      args: rest,
      options: {
        for: { type: 'string' },
        wake: { type: 'string' },
        'timeout-min': { type: 'string', default: '240' },
        repo: { type: 'string' }
      },
      allowPositionals: true,
      strict: true
    });

    if (!values.for) {
      throw new BastaoError('Comando wait exige --for=<agente>', 'INVALID_ARGS');
    }

    const forAgent = values.for;
    if (!['claude', 'gemini', 'codex'].includes(forAgent)) {
      throw new BastaoError(`Agente inválido: ${forAgent}`, 'INVALID_ARGS');
    }
    if (values.wake && !/^[\w-]+$/.test(values.wake)) {
      throw new BastaoError(`--wake inválido: ${values.wake} (use o Conversation ID)`, 'INVALID_ARGS');
    }
    if (!(await readState(repo))) throw new BastaoError('Nenhum ciclo ativo neste repositório', 'NO_CYCLE');
    const lockPath = path.join(repo, '.agents', `wait-${forAgent}.lock`);

    if (isLockAlive(lockPath)) {
      console.error(`bastao: já existe vigia ativo para ${forAgent}`);
      process.exit(4);
    }

    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), 'utf8');

    const cleanLock = () => {
      try {
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      } catch {}
    };

    process.on('exit', cleanLock);

    try {
      const wakeId = values.wake;
      if (wakeId) {
        const state = await readState(repo);
        if (state) {
          state.conversations = state.conversations || {};
          if (state.conversations.gemini !== wakeId) {
            state.conversations.gemini = wakeId;
            writeState(repo, state);
          }
        }
      }

      const pollMs = Number(process.env.BASTAO_POLL_MS) || 2000;
      const timeoutMin = Number(values['timeout-min']) || 240;
      const timeoutMs = timeoutMin * 60 * 1000;
      const startTime = Date.now();

      while (true) {
        try {
          fs.utimesSync(lockPath, new Date(), new Date());
        } catch {}

        const state = await readState(repo);

        if (state && ['APPROVED', 'MAX_ROUNDS_REACHED', 'MANUAL_PAUSE'].includes(state.status)) {
          if (wakeId) {
            sendAgentApiMessage(wakeId, 'Bastao: ciclo finalizado ou pausado. Rode: bastao status  e siga a skill bastao.');
          }
          console.log(`Estado terminal: ${state.status}`);
          cleanLock();
          process.exit(3);
        }

        if (state && state.current_turn === forAgent && state.status === 'IN_PROGRESS') {
          if (wakeId) {
            const ok = sendAgentApiMessage(wakeId, 'Bastao: sua vez. Rode: bastao status  e siga a skill bastao.');
            if (!ok) {
              state.history = state.history || [];
              state.history.push({
                at: new Date().toISOString(),
                from: 'wait',
                to: forAgent,
                action: 'wake_failed',
                round: state.round,
                notes: `Falha ao acordar ${forAgent}`,
                evidence: null
              });
              writeState(repo, state);
              notify(`[FALHA] Falha ao acordar ${forAgent}`);
              cleanLock();
              process.exit(5);
            }
          }
          console.log(formatInstructions(state));
          cleanLock();
          process.exit(0);
        }

        if (Date.now() - startTime >= timeoutMs) {
          if (wakeId) {
            sendAgentApiMessage(wakeId, 'Bastao: tempo esgotado. Rode o wait de novo conforme a skill bastao.');
          }
          console.log('TIMEOUT: rearme o wait');
          cleanLock();
          process.exit(2);
        }

        await sleep(pollMs);
      }
    } finally {
      cleanLock();
    }
  }

  if (command === '_codex') {
    const state = await readState(repo);
    if (!state || state.current_turn !== 'codex' || state.status !== 'IN_PROGRESS') {
      return;
    }

    let codexArgs = ['exec', '--sandbox', 'workspace-write', '-C', repo];
    if (state.conversations?.codex) {
      codexArgs.push('resume', state.conversations.codex);
    }
    codexArgs.push('-');

    const prompt = `${formatInstructions(state)}\n\nVocê é o Codex no Protocolo do Bastão. Siga a skill bastao. Termine SEMPRE com: bastao pass --from=codex …`;

    const liveDir = path.join(repo, '.agents', 'live');
    fs.mkdirSync(liveDir, { recursive: true });
    const logPath = path.join(liveDir, 'codex.log');

    const nowTime = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const separator = `\n=== Round ${state.round}/${state.max_rounds} · ${state.action} · ${nowTime} ===\n`;
    fs.appendFileSync(logPath, separator, 'utf8');

    // Qualquer falha (Codex ausente, spawn recusado) cai no applyAsk abaixo em vez de deixar o ciclo preso em codex.
    // ponytail: um codex.cmd de npm não roda sem shell; se aparecer, aponte BASTAO_CODEX para o .exe.
    let fullOutput = '';
    let exitCode;
    try {
      const codexBin = findCodex();
      const isNodeScript = codexBin.endsWith('.mjs');
      const execCmd = isNodeScript ? process.execPath : codexBin;
      const finalArgs = isNodeScript ? [codexBin, ...codexArgs] : codexArgs;

      const child = spawn(execCmd, finalArgs, {
        cwd: repo,
        windowsHide: true,
        env: process.env
      });

      child.stdin.on('error', () => {});
      child.stdin.write(prompt, 'utf8');
      child.stdin.end();

      child.stdout.on('data', chunk => {
        fullOutput += chunk.toString('utf8');
        fs.appendFileSync(logPath, chunk);
      });
      child.stderr.on('data', chunk => {
        fullOutput += chunk.toString('utf8');
        fs.appendFileSync(logPath, chunk);
      });

      exitCode = await new Promise(resolve => {
        child.on('error', err => resolve(err.message));
        child.on('close', resolve);
      });
    } catch (err) {
      exitCode = err.message;
    }
    if (typeof exitCode === 'string') fs.appendFileSync(logPath, `bastao: ${exitCode}\n`, 'utf8');

    if (!state.conversations?.codex) {
      const m = fullOutput.match(/session id:\s*([a-zA-Z0-9_-]+)/i);
      if (m) {
        const sessId = m[1];
        const cur = await readState(repo);
        if (cur) {
          cur.conversations = cur.conversations || {};
          cur.conversations.codex = sessId;
          writeState(repo, cur);
        }
      }
    }

    const latest = await readState(repo);
    if (latest && latest.current_turn === 'codex' && latest.status === 'IN_PROGRESS') {
      const question = `Codex terminou sem passar o bastão (exit ${exitCode ?? 0}). Veja .agents/live/codex.log`;
      const { state: nextState, notify: notifyMsg } = applyAsk(latest, {
        from: 'codex',
        question
      });
      writeState(repo, nextState);
      if (notifyMsg) notify(notifyMsg);
    }
    return;
  }

  throw new BastaoError(`Comando desconhecido: ${command}`, 'UNKNOWN_COMMAND');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    if (err instanceof BastaoError || err.code?.startsWith('ERR_PARSE_ARGS')) {
      console.error(`bastao: ${err.message}`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  }
}
