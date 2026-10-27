import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { BastaoError } from './erro.mjs';
import {
  SLUG_RE, mainRepoOf, toplevelOf, cyclePaths, listCycles, resolveCycle,
  indexPath, readIndex, addToIndex, removeFromIndex
} from './ciclos.mjs';
import { lastActivity, decideStall, isParado } from './parada.mjs';

export { BastaoError };

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export const AGENTS = ['claude', 'gemini', 'codex', 'human'];

export function parseRoles(str) {
  if (!str || typeof str !== 'string') return null;
  const res = { implement: 'gemini', review: ['claude'] };
  const checkAgent = a => {
    if (!['claude', 'gemini', 'codex'].includes(a)) throw new BastaoError(`--roles: agente inválido "${a}" (use claude, gemini, codex)`, 'INVALID_ARGS');
    return a;
  };
  for (const part of str.split(',').map(s => s.trim()).filter(Boolean)) {
    const [k, v] = part.split(':').map(s => s.trim());
    if (!v) throw new BastaoError(`--roles: "${part}" sem papel (vários revisores vão com +: review:claude+codex)`, 'INVALID_ARGS');
    if (k === 'implement') {
      res.implement = checkAgent(v);
    } else if (k === 'review') {
      res.review = v.split('+').map(s => s.trim()).filter(Boolean).map(checkAgent);
    } else {
      throw new BastaoError(`--roles: papel desconhecido "${k}" (use implement, review)`, 'INVALID_ARGS');
    }
  }
  return res;
}

export function slugify(task) {
  return (task || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ciclo';
}

export function initState({
  task,
  slug,
  spec,
  plan,
  implement = 'gemini',
  review = ['claude'],
  maxRounds = 3,
  codexThread = null,
  worktree = null,
  paradoMin = 15
}, now = new Date().toISOString()) {
  const reviewList = Array.isArray(review) ? review : [review];
  const stateSlug = slug || slugify(task);
  return {
    version: 3,
    task,
    slug: stateSlug,
    branch: `ai/${stateSlug}`,
    worktree,
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
    seq: 0,
    parado_min: Number(paradoMin) || 15,
    wake: null,
    stall: null,
    active_skills: ['ponytail', 'test-driven-development'],
    notes: '',
    last_evidence: null,
    ask_human: null,
    history: []
  };
}

// Estado da versão 2 (turn.json legado) ganha os campos novos ao ser lido.
export function normalizeState(s) {
  return {
    ...s,
    version: 3,
    worktree: s.worktree ?? null,
    seq: s.seq ?? (s.history || []).length,
    parado_min: s.parado_min ?? 15,
    wake: s.wake ?? null,
    stall: s.stall ?? null
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
  s.seq = (state.seq ?? 0) + 1;
  s.stall = null; // passagem nova, contagem de parada nova
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
  s.seq = (state.seq ?? 0) + 1;
  s.stall = null; // passagem nova, contagem de parada nova
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

  const notify = `[DÚVIDA] ${s.slug} · ${from}: ${question}`;
  return { state: s, notify };
}

export function applyPause(state, now = new Date().toISOString()) {
  const s = JSON.parse(JSON.stringify(state));
  s.seq = (state.seq ?? 0) + 1;
  s.stall = null; // passagem nova, contagem de parada nova
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

export function formatInstructions(state, { repoName = null, worktreeAbs = null } = {}) {
  const rolesStr = state.roles
    ? `implement:${state.roles.implement}, review:${(state.roles.review || []).join('+')}`
    : '';
  return [
    ...(repoName ? [`Ciclo: ${state.slug} (${repoName})`] : []),
    ...(worktreeAbs ? [`Workspace: ${worktreeAbs}`] : []),
    `Vez de: ${state.current_turn}`,
    `Ação: ${state.action}`,
    `Round: ${state.round}/${state.max_rounds}`,
    `Notas: ${state.notes || ''}`,
    `Spec: ${state.spec_file}`,
    `Plano: ${state.plan_file}`,
    `Última evidência: ${state.last_evidence || '(nenhuma)'}`,
    `Skills: ${(state.active_skills || []).join(', ')}`,
    `Papéis: ${rolesStr}`,
    `Ao terminar: bastao pass --from=${state.current_turn} --ciclo=${state.slug} …`
  ].join('\n');
}

export async function readState(file) {
  if (!fs.existsSync(file)) return null;

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return normalizeState(JSON.parse(raw));
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new BastaoError(`${path.basename(file)} inválido em ${file}`, 'CORRUPT_STATE');
      }
      lastErr = err;
      if (attempt < 3) await sleep(200);
    }
  }
  throw lastErr;
}

export function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpPath = file + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, file);
}

export function worktreeList(mainRepo) {
  const out = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: mainRepo, encoding: 'utf8' }).stdout || '';
  return out.split(/\r?\n\r?\n/).filter(Boolean).map(bloco => {
    const linhas = bloco.split(/\r?\n/);
    const branch = linhas.find(l => l.startsWith('branch ')) || '';
    return { path: path.normalize(linhas[0].replace(/^worktree /, '')), branch: branch.replace(/^branch refs\/heads\//, '') };
  });
}

const samePath = (a, b) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

// Cria .worktrees/<slug> na branch ai/<slug>; reaproveita o worktree ou a branch se já existirem.
export function ensureWorktree(mainRepo, slug, base) {
  const wt = path.join(mainRepo, '.worktrees', slug);
  const branch = `ai/${slug}`;
  const list = worktreeList(mainRepo);
  if (fs.existsSync(wt)) {
    if (list.some(w => samePath(w.path, wt) && w.branch === branch)) return wt;
    throw new BastaoError(`A pasta ${wt} existe mas não é o worktree de ${branch}; apague-a ou use outro --slug`, 'WORKTREE');
  }
  const emUso = list.find(w => w.branch === branch);
  if (emUso) {
    throw new BastaoError(`A branch ${branch} já está em uso em ${emUso.path}; troque de branch lá ou use outro --slug`, 'WORKTREE');
  }
  const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: mainRepo }).status === 0;
  const args = exists ? ['worktree', 'add', wt, branch] : ['worktree', 'add', '-b', branch, wt, base || 'HEAD'];
  const res = spawnSync('git', args, { cwd: mainRepo, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new BastaoError(`Não foi possível criar o worktree ${wt}: ${(res.stderr || res.stdout || '').trim()}`, 'WORKTREE');
  }
  return wt;
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
    '.agents/live/',
    '.agents/ciclos/',
    '.worktrees/'
  ];
  const existing = new Set(content.split(/\r?\n/).map(l => l.trim()));
  const missing = linesToAdd.filter(l => !existing.has(l));
  if (missing.length > 0) {
    if (content && !content.endsWith('\n')) content += '\n';
    content += missing.join('\n') + '\n';
    fs.writeFileSync(excludePath, content, 'utf8');
  }
}

// O agentapi só fala com o Antigravity tendo o endereço e o token do servidor dele, que só existem nos
// terminais do Antigravity. O vigia do Gemini os guarda aqui, no perfil (fora do repositório e do OneDrive),
// para o pass e os vigias de fora (Claude no VSCode, Codex) também conseguirem acordá-lo.
export function credsPath() {
  return process.env.BASTAO_CREDS
    || path.join(process.env.USERPROFILE || process.env.HOME || '', '.agents', 'bastao-antigravity.json');
}

function readCreds() {
  try {
    return JSON.parse(fs.readFileSync(credsPath(), 'utf8')).conversas || {};
  } catch {
    return {};
  }
}

export function saveCreds(conversationId, ls, csrf) {
  const file = credsPath();
  const conversas = { ...readCreds(), [conversationId]: { ls, csrf, at: new Date().toISOString() } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify({ conversas }, null, 2) + '\n', 'utf8');
  fs.renameSync(file + '.tmp', file);
}

function agentApiEnv(wakeId) {
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) return process.env;
  const c = readCreds()[wakeId];
  return c ? { ...process.env, ANTIGRAVITY_LS_ADDRESS: c.ls, ANTIGRAVITY_CSRF_TOKEN: c.csrf } : process.env;
}

export function sendAgentApiMessage(wakeId, text) {
  const bin = process.env.BASTAO_AGENTAPI
    || path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity-ide', 'bin', 'agentapi.bat');
  // Um agentapi travado não pode segurar o pass nem o vigia.
  const timeout = 15000;
  const env = agentApiEnv(wakeId);
  if (bin.endsWith('.mjs')) {
    return spawnSync(process.execPath, [bin, 'send-message', '--title=Bastao', wakeId, text], { windowsHide: true, timeout, env }).status === 0;
  }
  // cmd /s /c remove o primeiro e o último ", por isso a linha inteira vai entre aspas e sem o escape do libuv.
  // wakeId é validado no wait e o texto é fixo (sem & | < > ^ " %).
  const res = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${bin}" send-message --title=Bastao ${wakeId} "${text}""`], {
    windowsHide: true,
    windowsVerbatimArguments: true,
    timeout,
    env
  });
  return res.status === 0;
}

const CMD_UNSAFE = /[^\x20-\x7e]|[&|<>^"%]/;

// O texto vai pela linha de comando do cmd: só ASCII e sem & | < > ^ " %. Caminho inseguro é omitido.
export function wakeText(state, { repoName = '', worktreeAbs = null, rewake = false } = {}) {
  const repo = repoName.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(new RegExp(CMD_UNSAFE, 'g'), '');
  const ws = worktreeAbs && !CMD_UNSAFE.test(worktreeAbs) ? ` Workspace: ${worktreeAbs}.` : '';
  return `Bastao: sua vez no ciclo ${state.slug} (${repo}).${ws} Rode: bastao status --ciclo=${state.slug} e siga a skill bastao.`
    + (rewake ? ' Se ja estiver trabalhando, ignore.' : '');
}

// Relê o estado e grava fn(estado) só se ninguém passou o bastão desde a passagem `seq`.
export async function mergeState(file, seq, fn) {
  const cur = await readState(file);
  if (!cur || cur.seq !== seq) return false;
  writeState(file, fn(cur));
  return true;
}

// O pass grava wake.ok = null antes de enviar; o vigia não manda outro enquanto o envio é recente.
export function wakeHandled(state, now = Date.now()) {
  const w = state.wake;
  return w?.seq === state.seq && (w.ok === true || (w.ok === null && now - Date.parse(w.at) < 60000));
}

// Envia a mensagem de acordar à conversa registrada do Gemini e grava o resultado no estado.
export async function wakeGemini(file, state, opts) {
  const at = new Date().toISOString();
  const ok = sendAgentApiMessage(state.conversations.gemini, wakeText(state, opts));
  await mergeState(file, state.seq, cur => ({
    ...cur,
    wake: { seq: state.seq, at, ok },
    history: [...(cur.history || []), {
      at,
      from: 'bastao',
      to: 'gemini',
      action: ok ? 'wake' : 'wake_failed',
      round: state.round,
      notes: opts?.rewake ? 'reacordar' : 'acordar',
      evidence: null
    }]
  }));
  return ok;
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

const atividadeDe = (state, paths, mainRepo) =>
  lastActivity({ dir: paths.worktree || mainRepo, branch: state.branch, state });

// Há quanto tempo o dono está com o bastão, vigias vivos, se dá para acordá-lo e se está PARADO.
// Sem vigia vivo, a parada é calculada na hora (só para exibir).
export function situacaoDe(state, paths, mainRepo) {
  const vivos = ['claude', 'gemini', 'codex'].filter(a => isLockAlive(paths.lock(a)));
  const dono = state.current_turn;
  const acordavel = dono === 'gemini' ? !!state.conversations?.gemini
    : dono === 'claude' ? vivos.includes('claude')
      : dono === 'codex';
  const idle = Date.now() - atividadeDe(state, paths, mainRepo);
  const parado = isParado(state)
    || (vivos.length === 0 && state.status === 'IN_PROGRESS' && dono !== 'human' && idle >= state.parado_min * 60000);
  return { minutos: Math.round(idle / 60000), vivos, acordavel, parado };
}

// Uma linha por ciclo de todos os repositórios do índice; entradas cujo estado sumiu saem do índice.
async function statusTodos() {
  const { ciclos, corrupt } = readIndex();
  if (corrupt) console.log(`Aviso: índice ${indexPath()} ilegível; ele será refeito pelos próximos init.`);
  if (ciclos.length === 0) console.log('bastao: nenhum ciclo registrado');
  for (const { repo, slug } of ciclos) {
    const found = fs.existsSync(repo) ? listCycles(repo).find(c => c.slug === slug) : null;
    if (!found) {
      removeFromIndex(repo, slug);
      continue;
    }
    const paths = cyclePaths(repo, slug, found.legacy);
    let state;
    try {
      state = await readState(paths.state);
    } catch (err) {
      console.log(`${path.basename(repo)}/${slug} · ${err.message}`);
      continue;
    }
    const s = situacaoDe(state, paths, repo);
    console.log(`${path.basename(repo)}/${slug} · vez de ${state.current_turn} (${state.action}) há ${s.minutos} min`
      + ` · vigias: ${s.vivos.join(', ') || 'nenhum'} · acordável: ${s.acordavel ? 'sim' : 'não'}${s.parado ? ' · PARADO' : ''}`);
    console.log(`  ${paths.worktree || repo}`);
  }
}

export function notify(text) {
  const dest = process.env.BASTAO_NOTIFY;
  if (dest === 'off') return;
  if (dest?.endsWith('.log')) {
    fs.appendFileSync(dest, text + '\n', 'utf8');
    return;
  }
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
  status  [--todos]
  init    --task= --spec= --plan= [--slug=] [--base=HEAD] [--implement=gemini] [--review=claude,codex] [--max-rounds=3] [--parado-min=15] [--codex-thread=] [--force]
  pass    --from= --to= --action= [--notes=] [--evidence=] [--skills=a,b] [--roles=implement:x,review:y+z] [--parado-min=] [--force]
  ask     --from= --question=
  pause
  wait    --for=<claude|gemini|codex> [--wake=<id>, gemini fora do Antigravity] [--timeout-min=240]
  fim     (só com ok do usuário: remove o worktree limpo e encerra o ciclo; a branch fica)
  install [--yes]
Todos aceitam --repo=<dir> e --ciclo=<slug>. Dentro de .worktrees/<slug> o ciclo é deduzido; na pasta
principal, pass/ask/wait/fim exigem --ciclo. Ciclo já existe? Use 'status' e 'pass', não 'init'.`);
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

  const flag = name => {
    const i = rest.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
    if (i === -1) return null;
    return rest[i].includes('=') ? rest[i].slice(name.length + 3) : rest[i + 1] || null;
  };

  if (command === 'status' && rest.includes('--todos')) {
    await statusTodos();
    return;
  }

  const repoArg = flag('repo');
  const startDir = repoArg ? path.resolve(process.cwd(), repoArg) : process.cwd();
  const mainRepo = mainRepoOf(startDir);
  const toplevel = toplevelOf(startDir);
  const repoName = path.basename(mainRepo);
  const resolve = explicitRequired => {
    const cycle = resolveCycle({ mainRepo, toplevel, ciclo: flag('ciclo'), explicitRequired });
    // Ciclos legados não passaram pelo init novo: entram no índice quando usados.
    if (cycle.legacy) addToIndex(mainRepo, cycle.slug);
    return cycle;
  };
  const instr = (state, cycle) => formatInstructions(state, { repoName, worktreeAbs: cycle.paths.worktree });
  // Toda notificação vira '[TAG] <repo>/<slug> ...'.
  const avisar = msg => notify(msg.replace(/^(\[[^\]]+\]) /, `$1 ${repoName}/`));
  const atividade = (state, cycle) => atividadeDe(state, cycle.paths, mainRepo);

  // Rodado pelos vigias: reacorda o Gemini parado uma vez e, persistindo, avisa o usuário (uma vez por parada).
  const checarParada = async cycle => {
    const state = await readState(cycle.paths.state);
    if (!state) return;
    const canRewake = state.current_turn === 'gemini' && !!state.conversations?.gemini && process.env.BASTAO_REWAKE !== 'off';
    const activityMs = atividade(state, cycle);
    const { action, stall } = decideStall(state, { now: Date.now(), activityMs, canRewake });
    if (action === 'none') return;
    // Só grava se ninguém passou o bastão enquanto calculávamos.
    const cur = await readState(cycle.paths.state);
    if (!cur || cur.seq !== state.seq) return;
    const next = { ...cur, stall };
    writeState(cycle.paths.state, next);
    if (action === 'rewake') {
      await wakeGemini(cycle.paths.state, next, { repoName, worktreeAbs: cycle.paths.worktree, rewake: true });
    } else if (action === 'notify') {
      const min = Math.round((Date.now() - activityMs) / 60000);
      avisar(`[PARADO] ${state.slug}: ${state.current_turn} sem atividade há ${min} min`);
    }
  };

  const situacao = (state, cycle) => {
    const s = situacaoDe(state, cycle.paths, mainRepo);
    return [
      `Com ${state.current_turn} há ${s.minutos} min`,
      `Vigias: ${s.vivos.join(', ') || 'nenhum'}`,
      `Acordável: ${s.acordavel ? 'sim' : 'não'}`,
      ...(s.parado ? ['PARADO: sem atividade além do limite; veja o dono do bastão'] : [])
    ];
  };

  if (command === 'init') {
    const { values } = parseArgs({
      args: rest,
      options: {
        task: { type: 'string' },
        slug: { type: 'string' },
        ciclo: { type: 'string' },
        spec: { type: 'string' },
        plan: { type: 'string' },
        base: { type: 'string' },
        implement: { type: 'string', default: 'gemini' },
        review: { type: 'string', default: 'claude' },
        'max-rounds': { type: 'string', default: '3' },
        'parado-min': { type: 'string', default: '15' },
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

    const slug = values.slug || values.ciclo || slugify(values.task);
    if (!SLUG_RE.test(slug)) {
      throw new BastaoError(`Slug inválido "${slug}" (use letras minúsculas, números e hífen)`, 'INVALID_ARGS');
    }
    const paths = cyclePaths(mainRepo, slug, false);
    if (fs.existsSync(paths.state) && !values.force) {
      throw new BastaoError(`Já existe um ciclo "${slug}" neste repositório. Use --force para sobrescrever.`, 'ACTIVE_CYCLE');
    }

    const wt = ensureWorktree(mainRepo, slug, values.base);
    ensureExclude(mainRepo);

    const reviewList = values.review ? values.review.split(',').map(s => s.trim()).filter(Boolean) : ['claude'];
    const state = initState({
      task: values.task,
      slug,
      spec: values.spec,
      plan: values.plan,
      implement: values.implement,
      review: reviewList,
      maxRounds: Number(values['max-rounds']) || 3,
      codexThread: values['codex-thread'] || null,
      worktree: `.worktrees/${slug}`,
      paradoMin: Number(values['parado-min']) || 15
    });

    writeState(paths.state, state);
    addToIndex(mainRepo, slug);
    console.log(`bastao: ciclo '${slug}' iniciado (vez de ${state.current_turn})`);
    console.log(`Worktree: ${wt}`);
    console.log(`Antes de implementar, rode lá: npm install`);
    for (const [label, rel] of [['Spec', values.spec], ['Plano', values.plan]]) {
      if (!fs.existsSync(path.join(wt, rel))) {
        console.log(`Aviso: ${label} ${rel} não existe no worktree; commite na base antes de passar o bastão.`);
      }
    }
    const semIgnorar = fs.readdirSync(mainRepo)
      .filter(f => /^(vitest|vite|eslint)\.config\.[cm]?[jt]s$|^tsconfig.*\.json$/.test(f))
      .filter(f => !fs.readFileSync(path.join(mainRepo, f), 'utf8').includes('.worktrees'));
    if (semIgnorar.length) {
      console.log(`Aviso: ${semIgnorar.join(', ')} não ignora(m) .worktrees/; testes e lint da pasta principal vão ler os worktrees.`);
    }
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
        'parado-min': { type: 'string' },
        force: { type: 'boolean', default: false },
        repo: { type: 'string' },
        ciclo: { type: 'string' }
      },
      allowPositionals: true,
      strict: true
    });

    const cycle = resolve(true);
    const file = cycle.paths.state;

    if (!values.from) throw new BastaoError('Comando pass exige --from', 'INVALID_ARGS');
    if (!values.to) throw new BastaoError('Comando pass exige --to', 'INVALID_ARGS');
    if (!values.action) throw new BastaoError('Comando pass exige --action', 'INVALID_ARGS');

    const state = await readState(file);
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
    if (Number(values['parado-min']) > 0) nextState.parado_min = Number(values['parado-min']);
    const acordarGemini = nextState.current_turn === 'gemini' && nextState.status === 'IN_PROGRESS';
    // Marca o envio antes de enviar, para o vigia do Gemini não mandar outro ao mesmo tempo.
    if (acordarGemini && nextState.conversations?.gemini) {
      nextState.wake = { seq: nextState.seq, at: new Date().toISOString(), ok: null };
    }

    writeState(file, nextState);
    if (notifyMsg) avisar(notifyMsg);
    console.log(`bastao: bastão passado para ${nextState.current_turn} (${nextState.action})`);

    if (acordarGemini) {
      const woke = !!nextState.conversations?.gemini
        && await wakeGemini(file, nextState, { repoName, worktreeAbs: cycle.paths.worktree });
      // Com o vigia do Gemini vivo (ele roda no Antigravity), ele vê o envio falho e acorda o Gemini.
      if (!woke && !isLockAlive(cycle.paths.lock('gemini'))) {
        const msg = `[BASTAO] ${nextState.slug}: vez do gemini, mas não consigo acordá-lo. `
          + `Abra o Gemini em ${cycle.paths.worktree || mainRepo} e diga "retome o bastão ${nextState.slug}".`;
        avisar(msg);
        console.log(`bastao: ${msg.slice('[BASTAO] '.length)}`);
      }
    }

    if (nextState.current_turn === 'codex' && nextState.status === 'IN_PROGRESS') {
      const bastaoScript = fileURLToPath(import.meta.url);
      const child = spawn(process.execPath, [bastaoScript, '_codex', `--repo=${mainRepo}`, `--ciclo=${cycle.slug}`], {
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
        repo: { type: 'string' },
        ciclo: { type: 'string' }
      },
      allowPositionals: true,
      strict: true
    });

    const cycle = resolve(true);
    const file = cycle.paths.state;

    if (!values.from || !values.question) {
      throw new BastaoError('Comando ask exige --from e --question', 'INVALID_ARGS');
    }

    const state = await readState(file);
    if (!state) throw new BastaoError('Nenhum ciclo ativo neste repositório', 'NO_CYCLE');

    const { state: nextState, notify: notifyMsg } = applyAsk(state, {
      from: values.from,
      question: values.question
    });

    writeState(file, nextState);
    if (notifyMsg) avisar(notifyMsg);
    console.log(`bastao: dúvida registrada. Aguardando resposta humana.`);
    return;
  }

  if (command === 'pause') {
    const file = resolve(false).paths.state;
    const state = await readState(file);
    if (!state) throw new BastaoError('Nenhum ciclo ativo neste repositório', 'NO_CYCLE');

    const { state: nextState } = applyPause(state);
    writeState(file, nextState);
    console.log('bastao: ciclo pausado manualmente (vez de human)');
    return;
  }

  if (command === 'status') {
    let cycle;
    try {
      cycle = resolve(false);
    } catch (err) {
      if (err.code === 'AMBIGUOUS_CYCLE') {
        for (const c of listCycles(mainRepo)) {
          const st = await readState(cyclePaths(mainRepo, c.slug, c.legacy).state);
          console.log(`${c.slug} · vez de ${st.current_turn} · ${st.action} · ${st.status}`);
        }
        console.log('Indique o ciclo com --ciclo=<slug>.');
        return;
      }
      if (err.code !== 'NO_CYCLE' || flag('ciclo')) throw err;
      console.log('bastao: nenhum ciclo ativo');
      return;
    }
    const state = await readState(cycle.paths.state);

    console.log(instr(state, cycle));
    for (const linha of situacao(state, cycle)) console.log(linha);
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
        repo: { type: 'string' },
        ciclo: { type: 'string' }
      },
      allowPositionals: true,
      strict: true
    });

    const cycle = resolve(true);
    const file = cycle.paths.state;

    if (!values.for) {
      throw new BastaoError('Comando wait exige --for=<agente>', 'INVALID_ARGS');
    }

    const forAgent = values.for;
    if (!['claude', 'gemini', 'codex'].includes(forAgent)) {
      throw new BastaoError(`Agente inválido: ${forAgent}`, 'INVALID_ARGS');
    }
    // Dentro do Antigravity a conversa do Gemini vem do ambiente; fora dele, só pelo --wake.
    const wakeId = values.wake || (forAgent === 'gemini' ? process.env.ANTIGRAVITY_CONVERSATION_ID : null);
    if (forAgent === 'gemini' && !wakeId) {
      throw new BastaoError('wait --for=gemini exige --wake=<Conversation ID> fora do Antigravity; sem ele ninguém acorda o Gemini', 'INVALID_ARGS');
    }
    if (wakeId && !/^[\w-]+$/.test(wakeId)) {
      throw new BastaoError(`--wake inválido: ${wakeId} (use o Conversation ID)`, 'INVALID_ARGS');
    }
    if (!(await readState(file))) throw new BastaoError('Nenhum ciclo ativo neste repositório', 'NO_CYCLE');
    const lockPath = cycle.paths.lock(forAgent);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

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
      if (wakeId) {
        if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
          saveCreds(wakeId, process.env.ANTIGRAVITY_LS_ADDRESS, process.env.ANTIGRAVITY_CSRF_TOKEN);
        }
        const state = await readState(file);
        if (state && state.conversations?.gemini !== wakeId) {
          await mergeState(file, state.seq, cur => ({ ...cur, conversations: { ...cur.conversations, gemini: wakeId } }));
        }
      }

      const pollMs = Number(process.env.BASTAO_POLL_MS) || 2000;
      const timeoutMin = Number(values['timeout-min']) || 240;
      const timeoutMs = timeoutMin * 60 * 1000;
      const startTime = Date.now();
      const stallEvery = Number(process.env.BASTAO_STALL_CHECK_MS) || 60000;
      let nextStallCheck = Date.now() + stallEvery;

      while (true) {
        try {
          fs.utimesSync(lockPath, new Date(), new Date());
        } catch {}

        if (Date.now() >= nextStallCheck) {
          nextStallCheck = Date.now() + stallEvery;
          await checarParada(cycle);
        }

        const state = await readState(file);

        if (state && ['APPROVED', 'MAX_ROUNDS_REACHED', 'MANUAL_PAUSE'].includes(state.status)) {
          if (wakeId) {
            sendAgentApiMessage(wakeId, `Bastao: ciclo ${state.slug} finalizado ou pausado. Rode: bastao status --ciclo=${state.slug} e siga a skill bastao.`);
          }
          console.log(`Estado terminal: ${state.status}`);
          cleanLock();
          process.exit(3);
        }

        if (state && state.current_turn === forAgent && state.status === 'IN_PROGRESS') {
          // O pass já acordou o Gemini nesta passagem: o vigia é só reserva.
          if (wakeId && !wakeHandled(state)) {
            if (!(await wakeGemini(file, state, { repoName, worktreeAbs: cycle.paths.worktree }))) {
              avisar(`[FALHA] ${state.slug}: falha ao acordar ${forAgent}`);
              cleanLock();
              process.exit(5);
            }
          }
          console.log(instr(state, cycle));
          cleanLock();
          process.exit(0);
        }

        if (Date.now() - startTime >= timeoutMs) {
          if (wakeId) {
            sendAgentApiMessage(wakeId, `Bastao: tempo esgotado no ciclo ${cycle.slug}. Rode o wait de novo conforme a skill bastao.`);
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

  if (command === 'fim') {
    parseArgs({ args: rest, options: { repo: { type: 'string' }, ciclo: { type: 'string' } }, allowPositionals: true, strict: true });
    const cycle = resolve(true);
    const vivos = ['claude', 'gemini', 'codex'].filter(a => isLockAlive(cycle.paths.lock(a)));
    if (vivos.length) {
      throw new BastaoError(`Há vigia ativo neste ciclo (${vivos.join(', ')}); encerre-o antes de rodar fim`, 'ACTIVE_WATCHER');
    }
    const wt = cycle.paths.worktree;
    if (wt) {
      // No Windows, git não apaga a pasta em que o próprio processo está: o worktree ficaria meio removido.
      const rel = path.relative(wt, process.cwd());
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        throw new BastaoError(`Rode o fim da pasta principal: bastao fim --ciclo=${cycle.slug} --repo=${mainRepo}`, 'INVALID_ARGS');
      }
      const registrado = () => worktreeList(mainRepo).some(w => samePath(w.path, wt));
      if (registrado()) {
        const st = spawnSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' });
        if (st.status !== 0) throw new BastaoError(`Não foi possível ler o estado do worktree ${wt}: ${(st.stderr || '').trim()}`, 'WORKTREE');
        if (st.stdout.trim()) throw new BastaoError(`O worktree ${wt} tem alterações não commitadas:\n${st.stdout.trim()}`, 'DIRTY_WORKTREE');
        const res = spawnSync('git', ['worktree', 'remove', wt], { cwd: mainRepo, encoding: 'utf8' });
        if (res.status !== 0 && registrado()) {
          throw new BastaoError(`Não foi possível remover o worktree ${wt}: ${(res.stderr || res.stdout || '').trim()}`, 'WORKTREE');
        }
      }
    }
    fs.rmSync(cycle.paths.state, { force: true });
    removeFromIndex(mainRepo, cycle.slug);
    console.log(`bastao: ciclo '${cycle.slug}' encerrado${wt ? '; worktree removido' : ''}; a branch ai/${cycle.slug} foi mantida`);
    if (wt && fs.existsSync(wt)) {
      console.log(`Aviso: a pasta ${wt} sobrou e não é mais um worktree; feche o que a estiver usando e apague-a à mão.`);
    }
    return;
  }

  if (command === '_codex') {
    const cycle = resolve(false);
    const workDir = cycle.paths.worktree || mainRepo;
    const file = cycle.paths.state;
    const state = await readState(file);
    if (!state || state.current_turn !== 'codex' || state.status !== 'IN_PROGRESS') {
      return;
    }

    let codexArgs = ['exec', '--sandbox', 'workspace-write', '-C', workDir];
    if (state.conversations?.codex) {
      codexArgs.push('resume', state.conversations.codex);
    }
    codexArgs.push('-');

    const prompt = `${instr(state, cycle)}\n\nVocê é o Codex no Protocolo do Bastão. Siga a skill bastao. Termine SEMPRE com: bastao pass --from=codex …`;

    const liveDir = cycle.paths.liveDir;
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
        cwd: workDir,
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
        const cur = await readState(file);
        if (cur) {
          cur.conversations = cur.conversations || {};
          cur.conversations.codex = sessId;
          writeState(file, cur);
        }
      }
    }

    const latest = await readState(file);
    if (latest && latest.current_turn === 'codex' && latest.status === 'IN_PROGRESS') {
      const question = `Codex terminou sem passar o bastão (exit ${exitCode ?? 0}). Veja ${path.relative(mainRepo, logPath)}`;
      const { state: nextState, notify: notifyMsg } = applyAsk(latest, {
        from: 'codex',
        question
      });
      writeState(file, nextState);
      if (notifyMsg) avisar(notifyMsg);
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
