import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export class BastaoError extends Error {
  constructor(message, code = 'GENERIC') {
    super(message);
    this.name = 'BastaoError';
    this.code = code;
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  const stateSlug = slug || (task ? task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'ciclo');
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
  const custom = process.env.BASTAO_AGENTAPI;
  if (custom) {
    if (custom.endsWith('.mjs')) {
      const res = spawnSync(process.execPath, [custom, 'send-message', '--title=Bastao', wakeId, text], {
        encoding: 'utf8'
      });
      return res.status === 0;
    }
    const res = spawnSync(custom, ['send-message', '--title=Bastao', wakeId, text], {
      encoding: 'utf8',
      shell: true
    });
    return res.status === 0;
  }
  const userProfile = process.env.USERPROFILE || '';
  const batPath = path.join(userProfile, '.gemini', 'antigravity-ide', 'bin', 'agentapi.bat');
  const res = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${batPath}" send-message --title=Bastao ${wakeId} "${text}"`], {
    encoding: 'utf8',
    windowsHide: true
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

  if (!command || ['--help', '-h', 'help'].includes(command)) {
    console.log('Uso: bastao <init|pass|ask|pause|status|wait|install> [opções]');
    return;
  }

  const repoArgIndex = rest.findIndex(a => a.startsWith('--repo=') || a === '--repo');
  let repoPath = null;
  if (repoArgIndex !== -1) {
    if (rest[repoArgIndex].startsWith('--repo=')) {
      repoPath = rest[repoArgIndex].split('=')[1];
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
      strict: false
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
      strict: false
    });

    if (!values.from) throw new BastaoError('Comando pass exige --from', 'INVALID_ARGS');
    if (!values.to) throw new BastaoError('Comando pass exige --to', 'INVALID_ARGS');
    if (!values.action) throw new BastaoError('Comando pass exige --action', 'INVALID_ARGS');

    const state = await readState(repo);
    if (!state) throw new BastaoError('Nenhum ciclo ativo neste repositório', 'NO_CYCLE');

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
      strict: false
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
      strict: false
    });

    if (!values.for) {
      throw new BastaoError('Comando wait exige --for=<agente>', 'INVALID_ARGS');
    }

    const forAgent = values.for;
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

  throw new BastaoError(`Comando desconhecido: ${command}`, 'UNKNOWN_COMMAND');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    if (err instanceof BastaoError) {
      console.error(`bastao: ${err.message}`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  }
}
