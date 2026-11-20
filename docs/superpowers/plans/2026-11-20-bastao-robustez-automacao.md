# Bastão — Robustez e Automação (Itens 2 a 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o `/bastao` (`C:\Users\eduar\.agents\bastao`) resistente à morte do `_codex` pelo Job Object do Windows, falhas transitórias do Codex, atrasos de wake do Gemini, falso-positivos de parada do Codex e caminhos de `--evidence` inexistentes.

**Architecture:** Reaproveita os locks e o loop de vigia (`bastao wait` / `checarParada`) já existentes em `bastao.mjs` e `parada.mjs`. `parada.mjs` passa a considerar o `mtime` de `codex.log` como atividade e antecipa o `rewake` de agentes acordáveis para `1/5` de `parado_min` (3 min no padrão de 15 min), mantendo a notificação `[PARADO]` em `parado_min` (15 min). `bastao.mjs` valida a existência de `--evidence` no `pass`, mantém lock com heartbeat no `_codex`, faz 1 retry automático via `resume` se o Codex sair sem passar o bastão, retenta `wake` falho do Gemini em 60s e relança o `_codex` a partir do vigia (`wait`) se o processo tiver morrido.

**Tech Stack:** Node.js (ES Modules, `node:test`, `node:assert/strict`, `node:fs`, `node:path`, `node:child_process`) — zero dependências externas.

## Global Constraints

- Repositório alvo: `C:\Users\eduar\.agents\bastao`.
- Zero dependências externas (apenas stdlib do Node.js).
- Todos os testes existentes e novos devem passar via `node --test` em `C:\Users\eduar\.agents\bastao`.
- Arquivos JSON gravados sem BOM (`writeJson`).
- Após atualizar `SKILL.md`, sincronizar nos 3 agentes com `node bastao.mjs install --yes`.

---

### Task 1: Atividade do `codex.log` e Fast Rewake em `parada.mjs`

**Files:**
- Modify: `C:\Users\eduar\.agents\bastao\parada.mjs:1-54`
- Test: `C:\Users\eduar\.agents\bastao\parada.test.mjs:1-100`

**Interfaces:**
- Produces:
  - `lastActivity({ dir, branch, state, liveDir = null }): number`
  - `decideStall(state, { now, activityMs, canRewake }): { action: 'none' | 'clear' | 'rewake' | 'notify', stall: object | null }`

- [ ] **Step 1: Atualizar e escrever os testes em `parada.test.mjs` para Fast Rewake (1/5 do limite) e `codex.log`**

Em `C:\Users\eduar\.agents\bastao\parada.test.mjs`, ajuste os testes de `decideStall` para o novo limiar (`rewake` aos 3 min quando `parado_min = 15`, `notify` aos 15 min) e adicione o teste de `liveDir/codex.log` em `lastActivity`:

```js
test('decideStall: dentro do limite de rewake não faz nada', () => {
  assert.deepEqual(decideStall(base(), { now: T0 + 2 * MIN, activityMs: T0, canRewake: true }), { action: 'none', stall: null });
  assert.deepEqual(decideStall(base(), { now: T0 + 14 * MIN, activityMs: T0, canRewake: false }), { action: 'none', stall: null });
});

test('decideStall: gemini acordável parado é reacordado uma vez em 1/5 do limite (3 min)', () => {
  const r = decideStall(base(), { now: T0 + 3 * MIN, activityMs: T0, canRewake: true });
  assert.equal(r.action, 'rewake');
  assert.deepEqual(r.stall, { since: iso(T0), rewake_at: iso(T0 + 3 * MIN), notified_at: null });
  const again = decideStall(base({ stall: r.stall }), { now: T0 + 10 * MIN, activityMs: T0, canRewake: true });
  assert.equal(again.action, 'none');
});

test('decideStall: depois do reenvio, avisa no limite (15 min) e só uma vez', () => {
  const stall = { since: iso(T0), rewake_at: iso(T0 + 3 * MIN), notified_at: null };
  const r = decideStall(base({ stall }), { now: T0 + 15 * MIN, activityMs: T0, canRewake: true });
  assert.equal(r.action, 'notify');
  assert.equal(r.stall.notified_at, iso(T0 + 15 * MIN));
  assert.equal(r.stall.rewake_at, stall.rewake_at);
  assert.equal(decideStall(base({ stall: r.stall }), { now: T0 + 90 * MIN, activityMs: T0, canRewake: true }).action, 'none');
});
```

E ao final de `parada.test.mjs`, adicione:

```js
test('lastActivity: mtime de codex.log em liveDir conta como atividade mesmo ignorado pelo git', () => {
  const repo = tempRepo();
  const branch = git(repo, 'branch', '--show-current').stdout.trim();
  const commitTs = Number(git(repo, 'log', '-1', '--format=%ct').stdout.trim()) * 1000;
  const state = { history: [{ at: iso(commitTs), from: 'claude' }] };
  const liveDir = path.join(repo, '.agents', 'live', 'c1');
  fs.mkdirSync(liveDir, { recursive: true });
  const logFile = path.join(liveDir, 'codex.log');
  fs.writeFileSync(logFile, 'rodando...');
  const novo = new Date(commitTs + 120_000);
  fs.utimesSync(logFile, novo, novo);
  assert.equal(lastActivity({ dir: repo, branch, state, liveDir }), novo.getTime());
});
```

- [ ] **Step 2: Rodar `node --test parada.test.mjs` e verificar que falha**

Run: `node --test C:\Users\eduar\.agents\bastao\parada.test.mjs`
Expected: FAIL nos testes de `decideStall` (3 min vs 15 min) e `lastActivity` (`liveDir`).

- [ ] **Step 3: Implementar `liveDir` em `lastActivity` e o Fast Rewake em `decideStall` (`parada.mjs`)**

Em `C:\Users\eduar\.agents\bastao\parada.mjs`:

```js
export function lastActivity({ dir, branch, state, liveDir = null }) {
  const events = (state.history || []).filter(h => h.from !== 'bastao');
  if (events.length === 0) return Date.now();
  let last = Date.parse(events.at(-1).at) || 0;

  if (liveDir) {
    try {
      last = Math.max(last, fs.statSync(path.join(liveDir, 'codex.log')).mtimeMs);
    } catch {}
  }

  const log = git(dir, ['log', '-1', '--format=%ct', branch]);
  if (log.status === 0) last = Math.max(last, Number(log.stdout.trim()) * 1000 || 0);

  const st = git(dir, ['status', '--porcelain=v1', '-uall', '-z']);
  if (st.status === 0) {
    const entries = st.stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.length < 4) continue;
      if (e[0] === 'R' || e[0] === 'C') i++; // o próximo campo é o caminho de origem
      try {
        last = Math.max(last, fs.statSync(path.join(dir, e.slice(3))).mtimeMs);
      } catch {}
    }
  }
  return last;
}

export function decideStall(state, { now, activityMs, canRewake }) {
  const stall = state.stall ?? null;
  if (state.status !== 'IN_PROGRESS' || state.current_turn === 'human') return { action: 'none', stall };
  if (stall && activityMs > Date.parse(stall.since)) return { action: 'clear', stall: null };

  const limit = state.parado_min * 60000;
  const rewakeLimit = limit / 5;
  const idle = now - activityMs;
  const iso = ms => new Date(ms).toISOString();

  if (canRewake) {
    if (idle < rewakeLimit) return { action: 'none', stall };
    if (!stall) {
      return { action: 'rewake', stall: { since: iso(activityMs), rewake_at: iso(now), notified_at: null } };
    }
    if (idle >= limit && stall.rewake_at && !stall.notified_at) {
      return { action: 'notify', stall: { ...stall, notified_at: iso(now) } };
    }
    return { action: 'none', stall };
  }

  if (idle < limit) return { action: 'none', stall };
  if (!stall) {
    return { action: 'notify', stall: { since: iso(activityMs), rewake_at: null, notified_at: iso(now) } };
  }
  return { action: 'none', stall };
}
```

- [ ] **Step 4: Rodar `node --test parada.test.mjs` e confirmar que passa**

Run: `node --test C:\Users\eduar\.agents\bastao\parada.test.mjs`
Expected: PASS (100% dos testes em `parada.test.mjs`).

---

### Task 2: Validação de `--evidence`, Lock/Heartbeat/Retry do `_codex` e Supervisão no `wait` (`bastao.mjs`, `SKILL.md`, `test.mjs`)

**Files:**
- Modify: `C:\Users\eduar\.agents\bastao\bastao.mjs`
- Modify: `C:\Users\eduar\.agents\bastao\SKILL.md`
- Test: `C:\Users\eduar\.agents\bastao\test.mjs`

**Interfaces:**
- Consumes: `lastActivity({ dir, branch, state, liveDir })` e `decideStall` de `./parada.mjs`.
- Produces:
  - Validação `EVIDENCE_NOT_FOUND` em `bastao pass --evidence=<caminho>` (salvo `--force`).
  - Lock `.agents/ciclos/<slug>.wait-codex.lock` com heartbeat durante `_codex`.
  - 1 retry automático via `codex exec ... resume <sessionId> -` em `_codex` quando o Codex encerra sem passar o bastão.
  - Supervisão no `bastao wait` / `checarParada` para relançar `_codex` morto e retentar `wakeGemini` quando `wake.ok === false`.

- [ ] **Step 1: Adicionar os novos testes em `test.mjs`**

Ao final de `C:\Users\eduar\.agents\bastao\test.mjs`, adicione os testes para os Itens 2, 3, 4 e 5:

```js
test('pass: recusa --evidence que não existe no worktree (salvo --force) e aceita quando existe', () => {
  const repo = tempRepo();
  runCli(['init', '--task=ev', '--slug=ev', '--spec=s', '--plan=p', `--repo=${repo}`], repo);
  runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', `--repo=${repo}`, '--ciclo=ev'], repo);

  const falho = runCli([
    'pass', '--from=gemini', '--to=claude', '--action=review',
    '--evidence=docs/evidence/nao-existe.md', `--repo=${repo}`, '--ciclo=ev'
  ], repo);
  assert.equal(falho.status, 1);
  assert.match(falho.stderr, /Arquivo de evidência não encontrado/i);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'ciclos', 'ev.json'), 'utf8')).current_turn, 'gemini');

  const wt = path.join(repo, '.worktrees', 'ev');
  fs.mkdirSync(path.join(wt, 'docs', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'docs', 'evidence', 'ok.md'), '# Evidencia');

  const ok = runCli([
    'pass', '--from=gemini', '--to=claude', '--action=review',
    '--evidence=docs/evidence/ok.md', `--repo=${repo}`, '--ciclo=ev'
  ], repo);
  assert.equal(ok.status, 0, `stderr: ${ok.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'ciclos', 'ev.json'), 'utf8')).current_turn, 'claude');
});

test('vigia de outro agente retenta wakeGemini quando o wake inicial do pass falhou', async () => {
  const { repo, file } = cicloComGemini('retwake', 'conv-rw');
  const { scriptPath, logPath } = setupFakeAgentApi();
  // Pass falha no wake (FAKE_EXIT=1) com lock do gemini simulado para não notificar na hora
  runCli(['pass', '--from=claude', '--to=gemini', '--action=implement', `--repo=${repo}`, '--ciclo=retwake'], repo,
    { BASTAO_AGENTAPI: scriptPath, FAKE_EXIT: '1' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).wake.ok, false);

  // Vigia do claude roda checarParada rapidamente com FAKE_EXIT=0 e corrige o wake
  const vigia = spawn(process.execPath, [
    BASTAO_CLI, 'wait', '--for=claude', '--timeout-min=0.01', `--repo=${repo}`, '--ciclo=retwake'
  ], {
    cwd: repo,
    env: { ...process.env, BASTAO_AGENTAPI: scriptPath, FAKE_LOG: logPath, BASTAO_POLL_MS: '50', BASTAO_STALL_CHECK_MS: '80' }
  });
  await new Promise(resolve => vigia.on('close', resolve));

  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(st.wake.ok, true, 'checarParada deve ter reenviado o wake falho');
  assert.ok(fs.existsSync(logPath));
});

test('codex: faz 1 retry automático via resume quando a 1ª tentativa sai sem passar o bastão e recupera na 2ª', async () => {
  const repo = tempRepo();
  const tmpDir = fs.mkdtempSync(path.join(ROOT, 'fake-codex-retry-'));
  const scriptPath = path.join(tmpDir, 'fake-codex-retry.mjs');
  const countFile = path.join(tmpDir, 'count.txt');
  fs.writeFileSync(scriptPath, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => stdin += c);
process.stdin.on('end', () => {
  const n = fs.existsSync(${JSON.stringify(countFile)}) ? Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8')) + 1 : 1;
  fs.writeFileSync(${JSON.stringify(countFile)}, String(n), 'utf8');
  process.stdout.write('session id: sess-retry-1\\n');
  if (n >= 2 && process.argv.includes('resume')) {
    const cIndex = process.argv.indexOf('-C');
    const workDir = cIndex !== -1 ? process.argv[cIndex + 1] : process.cwd();
    spawnSync(process.execPath, [
      ${JSON.stringify(BASTAO_CLI)}, 'pass', '--repo=' + workDir, '--from=codex', '--to=claude', '--action=review'
    ], { stdio: 'inherit' });
  }
  process.exit(0);
});
`, 'utf8');

  runCli(['init', '--task=r', '--slug=cretry', '--spec=s', '--plan=p', `--repo=${repo}`], repo);
  runCli(['pass', '--from=claude', '--to=codex', '--action=implement', `--repo=${repo}`, '--ciclo=cretry'], repo,
    { BASTAO_CODEX: scriptPath });

  const start = Date.now();
  let state = null;
  while (Date.now() - start < 15000) {
    await new Promise(r => setTimeout(r, 100));
    state = JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'ciclos', 'cretry.json'), 'utf8'));
    if (state.current_turn === 'claude') break;
  }
  assert.equal(state.current_turn, 'claude', 'Retry automático deve ter concluído o pass para claude');
  assert.equal(state.status, 'IN_PROGRESS');
  assert.equal(fs.readFileSync(countFile, 'utf8'), '2');
  const liveLog = fs.readFileSync(path.join(repo, '.agents', 'live', 'cretry', 'codex.log'), 'utf8');
  assert.match(liveLog, /Retry automático/);
});

test('wait: supervisiona e relança _codex se o processo do codex tiver morrido sem lock ativo', async () => {
  const repo = tempRepo();
  const { scriptPath, logPath } = setupFakeCodex();
  runCli(['init', '--task=sup', '--slug=csup', '--spec=s', '--plan=p', `--repo=${repo}`], repo);
  const file = path.join(repo, '.agents', 'ciclos', 'csup.json');
  // Simula estado em que o bastão foi passado para codex mas o processo _codex morreu junto com o shell do pass
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  st.current_turn = 'codex';
  st.action = 'implement';
  st.seq = 1;
  st.history.push({ at: new Date(Date.now() - 5000).toISOString(), from: 'claude', to: 'codex', action: 'implement', round: 1, notes: '' });
  fs.writeFileSync(file, JSON.stringify(st));

  const res = runCli(['wait', '--for=claude', '--timeout-min=0.2', `--repo=${repo}`, '--ciclo=csup'], repo, {
    BASTAO_CODEX: scriptPath,
    BASTAO_CLI_PATH: BASTAO_CLI,
    FAKE_LOG: logPath,
    FAKE_PASS: '1',
    BASTAO_POLL_MS: '50',
    BASTAO_CODEX_GRACE_MS: '100'
  });
  assert.equal(res.status, 0, `wait deve acordar claude após relançar _codex; stderr: ${res.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).current_turn, 'claude');
});
```

- [ ] **Step 2: Implementar as mudanças em `bastao.mjs`**

1. Em `atividadeDe` (`bastao.mjs:496-497`), passe `liveDir: paths.liveDir`:
   ```js
   const atividadeDe = (state, paths, mainRepo) =>
     lastActivity({ dir: paths.worktree || mainRepo, branch: state.branch, state, liveDir: paths.liveDir });
   ```
2. Adicione o helper `spawnCodexDetached(mainRepo, slug)`:
   ```js
   function spawnCodexDetached(mainRepo, slug) {
     const bastaoScript = fileURLToPath(import.meta.url);
     const child = spawn(process.execPath, [bastaoScript, '_codex', `--repo=${mainRepo}`, `--ciclo=${slug}`], {
       detached: true,
       stdio: 'ignore',
       windowsHide: true,
       env: process.env
     });
     child.unref();
   }
   ```
3. Em `checarParada` (`bastao.mjs:702-720`), adicione o retry do `wakeGemini` quando `!wakeHandled(state)`:
   ```js
   const checarParada = async cycle => {
     const state = await readState(cycle.paths.state);
     if (!state) return;
     const canRewake = state.current_turn === 'gemini' && !!state.conversations?.gemini && process.env.BASTAO_REWAKE !== 'off';
     if (state.status === 'IN_PROGRESS' && canRewake && !wakeHandled(state)) {
       await wakeGemini(cycle.paths.state, state, { repoName, worktreeAbs: cycle.paths.worktree });
       return;
     }
     const activityMs = atividade(state, cycle);
     const { action, stall } = decideStall(state, { now: Date.now(), activityMs, canRewake });
     ...
   ```
4. Em `command === 'pass'` (`bastao.mjs:843`), antes de `applyPass`, valide `--evidence`:
   ```js
   if (values.evidence && !values.force) {
     const baseDir = cycle.paths.worktree || mainRepo;
     if (!fs.existsSync(path.resolve(baseDir, values.evidence))) {
       throw new BastaoError(`Arquivo de evidência não encontrado: ${values.evidence}`, 'EVIDENCE_NOT_FOUND');
     }
   }
   ```
   E substitua o bloco de spawn do `_codex` (`bastao.mjs:876-885`) por `spawnCodexDetached(mainRepo, cycle.slug)`.
5. No loop de `command === 'wait'` (`bastao.mjs:1040-1086`), adicione `let lastCodexSpawn = 0;` antes do `while (true)` e, dentro do loop, após ler `const state = await readState(file);`:
   ```js
   if (state && state.current_turn === 'codex' && state.status === 'IN_PROGRESS' && !isLockAlive(cycle.paths.lock('codex'))) {
     const lastPassMs = Date.parse((state.history || []).filter(h => h.from !== 'bastao').at(-1)?.at) || 0;
     const graceMs = Number(process.env.BASTAO_CODEX_GRACE_MS) || 2000;
     if (Date.now() - lastPassMs >= graceMs && Date.now() - lastCodexSpawn >= Math.max(graceMs, 2000)) {
       lastCodexSpawn = Date.now();
       spawnCodexDetached(mainRepo, cycle.slug);
     }
   }
   ```
6. Em `command === '_codex'` (`bastao.mjs:1126-1216`):
   - Gerencie `const lockPath = cycle.paths.lock('codex')`: se `isLockAlive(lockPath)` for verdadeiro, retorne imediatamente; senão grave `{ pid: process.pid, started_at: new Date().toISOString() }`, mantenha `setInterval` atualizando `utimesSync` a cada `pollMs` (`Number(process.env.BASTAO_POLL_MS) || 2000`) e remova no `finally`/`exit`.
   - Encapsule a execução do processo do Codex em uma função auxiliar `execCodex(sessionId, promptText)` que grava no `logPath`, extrai `session id: <id>` do `fullOutput` (salvando em `conversations.codex` no arquivo de estado se novo) e retorna `{ exitCode, sessionId }`.
   - Se após a 1ª execução o estado ainda estiver com `current_turn === 'codex' && status === 'IN_PROGRESS'`, e houver `sessionId` (e `typeof exitCode === 'number'` e `process.env.BASTAO_CODEX_RETRY !== '0'`), grave `\n=== Retry automático · Round ${latest.round}/${latest.max_rounds} · ${latest.action} ===\n` no `logPath` e execute 1 retry com `execCodex(sessionId, retryPrompt)` antes de cair no `applyAsk` (`WAITING_HUMAN`).

- [ ] **Step 3: Atualizar `SKILL.md` e sincronizar com `node bastao.mjs install --yes`**

Em `C:\Users\eduar\.agents\bastao\SKILL.md`:
- Na seção `### Codex` (linha 42), documente que o `_codex` agora mantém lock de heartbeat (`.wait-codex.lock`), faz 1 retry automático via `resume` se encerrar sem passar o bastão e é relançado automaticamente pelo vigia (`bastao wait`) caso o Job Object do terminal do `pass` o encerre.
- Na seção `### Acordar e parada` (linha 47), documente que o `rewake` automático do Gemini ocorre em `1/5` de `parado_min` (3 min no padrão de 15 min) e o alerta `PARADO` ocorre em `parado_min` (15 min), além de `codex.log` contar como atividade.

- [ ] **Step 4: Rodar toda a suíte de testes e instalar a skill atualizada**

Run:
```powershell
node --test C:\Users\eduar\.agents\bastao\parada.test.mjs C:\Users\eduar\.agents\bastao\ciclos.test.mjs C:\Users\eduar\.agents\bastao\test.mjs
node C:\Users\eduar\.agents\bastao\bastao.mjs install --yes
```
Expected: 100% dos testes passando com 0 falhas e skill instalada nos 3 destinos (`.claude`, `.gemini`, `.codex`).

- [ ] **Step 5: Fazer commit das alterações em `C:\Users\eduar\.agents\bastao`**

```powershell
git -C "$env:USERPROFILE\.agents\bastao" add parada.mjs parada.test.mjs bastao.mjs test.mjs SKILL.md
git -C "$env:USERPROFILE\.agents\bastao" commit -m "feat: fast rewake, heartbeat/supervisao/retry do codex e validacao de evidence"
```
