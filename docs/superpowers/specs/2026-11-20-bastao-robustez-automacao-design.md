# Bastão — Robustez e Automação (Itens 2 a 5) — Design

Data: 2026-11-20 · Status: aprovado pelo usuário

## 1. Objetivo

Eliminar quatro pontos de falha operacional observados no uso real do `/bastao`:

1. **Item 2 (Evidência inexistente no `pass`):** agentes passando `--evidence=<caminho>` com caminho errado ou arquivo não salvo no disco.
2. **Item 3 (Atividade real do Codex):** `lastActivity` ignorava `.agents/live/<slug>/codex.log` (por estar em `.git/info/exclude`), marcando o Codex como `PARADO` durante análises ou baterias de teste longas, e o `_codex` não mantinha lock de heartbeat vivo.
3. **Item 4 (Fast Rewake e Retry de Wake do Gemini):** quando o `wake` inicial falhava e o vigia do Gemini não estava rodando, o vigia de outro agente esperava 15 min inteiros antes de agir; quando o `wake` dava `ok: true` mas a sessão não engatava, o 1º `rewake` demorava 15 min e o aviso `[PARADO]` só saía em 30 min.
4. **Item 5 (Morte do `_codex` pelo Job Object do Windows + Retry automático):** como `bastao pass --to=codex` termina sincronamente em milissegundos, o Job Object do terminal que executou o `pass` pode encerrar o processo filho `_codex` junto com o shell. Além disso, falhas transitórias do Codex que encerram o processo sem rodar `bastao pass` derrubavam o ciclo imediatamente para `WAITING_HUMAN`.

### Fora de escopo

- Item 1 (auto-spawn de `wait --for=gemini` no `pass`): descartado pelo usuário nesta etapa.
- Bloquear `bastao pass` quando o worktree tiver alterações não commitadas: descartado porque o Codex cria arquivos de evidência no worktree sem executar `git commit`.

---

## 2. Componentes e Fluxo de Dados

### 2.1. Item 2 — Validação de `--evidence` no `bastao pass` (`bastao.mjs`)

- Quando `bastao pass` recebe `--evidence=<caminho>` (não vazio) e `--force` **não** está presente:
  - Resolve o caminho absoluto a partir da pasta de trabalho do ciclo: `path.resolve(cycle.paths.worktree || mainRepo, values.evidence)`.
  - Se `!fs.existsSync(evidenceAbs)`, lança `new BastaoError(\`Arquivo de evidência não encontrado: \${values.evidence}\`, 'EVIDENCE_NOT_FOUND')` antes de alterar o arquivo de estado.
- Se `--evidence` não for informado ou se `--force` for passado, nenhuma verificação de existência de evidência é feita.

### 2.2. Item 3 — Atividade real e Lock de Heartbeat do Codex (`parada.mjs`, `bastao.mjs`)

- **`codex.log` em `lastActivity` (`parada.mjs`):**
  - `lastActivity({ dir, branch, state, liveDir })` recebe opcionalmente `liveDir`.
  - Se `liveDir` for informado, verifica `path.join(liveDir, 'codex.log')`; se existir, inclui seu `fs.statSync(...).mtimeMs` no `Math.max` da última atividade.
  - `atividadeDe(state, paths, mainRepo)` em `bastao.mjs` passa `liveDir: paths.liveDir` para `lastActivity`.
- **Lock de heartbeat do `_codex` (`bastao.mjs`):**
  - No comando `_codex`, antes de iniciar o processo do Codex, verifica `const lockPath = cycle.paths.lock('codex')`.
  - Se `isLockAlive(lockPath)` for verdadeiro, encerra imediatamente (`return;`) para evitar execução duplicada.
  - Grava `{ pid: process.pid, started_at: new Date().toISOString() }` em `lockPath` e inicia um timer `setInterval` (a cada `Number(process.env.BASTAO_POLL_MS) || 2000` ms) que atualiza `fs.utimesSync(lockPath, new Date(), new Date())`.
  - No bloco `finally` e no `process.on('exit')`, limpa o `setInterval` e remove `lockPath`.

### 2.3. Item 4 — Fast Rewake e Retry de Wake do Gemini (`parada.mjs`, `bastao.mjs`)

- **Retry de `wake` inicial falho em `checarParada` (`bastao.mjs`):**
  - Em `checarParada(cycle)`, se `state.status === 'IN_PROGRESS' && state.current_turn === 'gemini' && canRewake && !wakeHandled(state)`:
    - Chama `await wakeGemini(cycle.paths.state, state, { repoName, worktreeAbs: cycle.paths.worktree })` e retorna.
    - Isso garante que qualquer vigia vivo (ex.: `wait --for=claude`) retente o `wake` em até 60s quando o envio do `pass` tiver falhado (`wake.ok === false`).
- **Fast Rewake aos 3 min (`limit / 5`) e `[PARADO]` aos 15 min (`limit`) (`parada.mjs`):**
  - Em `decideStall(state, { now, activityMs, canRewake })`:
    - `const limit = state.parado_min * 60000;`
    - `const rewakeLimit = limit / 5;` (para `parado_min = 15`, `rewakeLimit` é **3 min** e `limit` é **15 min**).
    - Se `canRewake` for verdadeiro:
      - Se `idle < rewakeLimit`: retorna `{ action: 'none', stall }`.
      - Se `!stall` (e `idle >= rewakeLimit`): retorna `{ action: 'rewake', stall: { since: iso(activityMs), rewake_at: iso(now), notified_at: null } }`.
      - Se `idle >= limit && stall.rewake_at && !stall.notified_at`: retorna `{ action: 'notify', stall: { ...stall, notified_at: iso(now) } }`.
      - Caso contrário: retorna `{ action: 'none', stall }`.
    - Se `canRewake` for falso:
      - Se `idle < limit`: retorna `{ action: 'none', stall }`.
      - Se `!stall`: retorna `{ action: 'notify', stall: { since: iso(activityMs), rewake_at: null, notified_at: iso(now) } }`.
      - Caso contrário: retorna `{ action: 'none', stall }`.

### 2.4. Item 5 — Supervisão do `_codex` pelo vigia + 1 Retry Automático (`bastao.mjs`, `SKILL.md`)

- **Supervisão no vigia (`bastao wait`):**
  - Extraímos helper `spawnCodexDetached(mainRepo, slug)` para disparar `_codex` em background.
  - No loop de `bastao wait` (ou dentro de `checarParada` e no loop principal), quando `state && state.current_turn === 'codex' && state.status === 'IN_PROGRESS' && !isLockAlive(cycle.paths.lock('codex'))`:
    - Verifica a idade do último evento de passagem no `state.history` (`Date.now() - (Date.parse(state.history.at(-1)?.at) || 0)`).
    - Se já passou pelo menos `Math.max(pollMs, 1500)` ms (ou `Number(process.env.BASTAO_CODEX_GRACE_MS) || 2000` ms) desde a passagem para o Codex e o lock continua inativo, chama `spawnCodexDetached(mainRepo, cycle.slug)` para relançar o `_codex` sob a árvore persistente do vigia.
- **1 Retry Automático no `_codex` antes de `WAITING_HUMAN`:**
  - Extraímos a execução do processo filho do Codex em uma função interna `runCodexTurn({ codexBin, workDir, codexArgs, prompt, logPath })`.
  - Após a 1ª execução terminar e atualizar `conversations.codex` (se `session id: <id>` tiver aparecido no output):
  - Lê o estado mais recente (`latest = await readState(file)`).
  - Se `latest && latest.current_turn === 'codex' && latest.status === 'IN_PROGRESS'`:
    - Se existir `latest.conversations?.codex` (sessão para `resume`) e `process.env.BASTAO_CODEX_RETRY !== '0'`:
      - Grava no `logPath`: `\n=== Retry automático · Round ${latest.round}/${latest.max_rounds} · ${latest.action} ===\n`.
      - Monta `retryArgs` com `resume`, `latest.conversations.codex`, `-` e `retryPrompt`:
        `${instr(latest, cycle)}\n\nVocê é o Codex no Protocolo do Bastão. Seu turno anterior encerrou sem passar o bastão. Conclua o que faltar e termine SEMPRE com: bastao pass --from=codex …`
      - Executa `runCodexTurn` uma segunda vez e relê `latest = await readState(file)`.
    - Se após essa verificação `latest && latest.current_turn === 'codex' && latest.status === 'IN_PROGRESS'`, aplica `applyAsk` (`WAITING_HUMAN`) exatamente como hoje.

---

## 3. Tratamento de Erros e Compatibilidade

- Todos os códigos de saída do `bastao wait` (`0` a `5`) permanecem inalterados.
- `EVIDENCE_NOT_FOUND` é um `BastaoError` que imprime `bastao: Arquivo de evidência não encontrado: ...` no `stderr` e sai com código `1`.
- Se o binário do Codex não existir (`CODEX_NOT_FOUND`), nenhuma `session id` é produzida, portanto o retry não roda à toa e o ciclo vai imediatamente para `WAITING_HUMAN`.

## 4. Testes Automatizados (`node --test`)

1. **`parada.test.mjs`:**
   - Ajustar os testes de `decideStall` para o novo limiar de `rewake` em `parado_min / 5` (3 min para padrão 15 min) e `notify` em `parado_min` (15 min).
   - Novo teste de `lastActivity` confirmando que o `mtime` de `<liveDir>/codex.log` atualiza a última atividade mesmo estando em pasta ignorada pelo git.
2. **`test.mjs`:**
   - Item 2: `bastao pass --evidence=nao-existe.md` falha com código 1 e mensagem clara; com arquivo existente no worktree (ou com `--force`) passa com código 0.
   - Item 3: `_codex` mantém `cycle.paths.lock('codex')` vivo durante a execução e recusa segunda instância simultânea.
   - Item 4: vigia de outro agente (`wait --for=claude`) retenta `wakeGemini` quando `wake.ok === false` sem esperar `parado_min`.
   - Item 5a: `_codex` que sai sem passar o bastão na 1ª tentativa mas produziu `session id` faz 1 retry automático com `resume <id>` e, se passar o bastão no retry, conclui o turno sem cair em `WAITING_HUMAN`.
   - Item 5b: se o `_codex` morrer ao sair do `pass`, o `bastao wait` detecta a ausência do lock do `codex` e relança o `_codex` automaticamente.
