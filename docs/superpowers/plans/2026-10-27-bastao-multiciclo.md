# Bastão multiciclo — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** vários ciclos do bastão por repositório, cada um em seu worktree, com o `pass` acordando o Gemini e um detector de parada.

**Architecture:** `bastao.mjs` continua sendo a CLI e o fluxo de estado (`applyPass`, `applyAsk`...). Dois módulos novos: `ciclos.mjs` (onde fica cada ciclo, qual ciclo um comando usa, índice global, worktree) e `parada.mjs` (atividade e decisão de parada, puro). Leitura e gravação de estado passam a receber o caminho do arquivo do ciclo em vez do repositório.

**Tech Stack:** Node ≥ 20 (ESM, `node:test`, `node:util.parseArgs`), git CLI. Nenhuma dependência nova.

**Spec:** `docs/superpowers/specs/2026-10-27-bastao-multiciclo-design.md`

## Global Constraints

- Trabalho na branch `feat/multiciclo`, worktree `C:\Users\eduar\.agents\bastao\.worktrees\multiciclo`. Merge no `master` só com ok do usuário.
- Nenhuma dependência npm. Arquivos `.mjs`, estilo do `bastao.mjs` (mensagens em português, `BastaoError(msg, code)`).
- JSON gravado em UTF-8 sem BOM, via arquivo `.tmp` + `rename`.
- Testes nunca tocam o índice real: `runCli` define `BASTAO_INDEX` num arquivo dentro de `ROOT` e `BASTAO_NOTIFY=off`.
- Comando de testes (sempre explícito, para não pegar cópias em `.worktrees/`): `node --test test.mjs ciclos.test.mjs parada.test.mjs`
- Mensagem de acordar sem `& | < > ^ " %`; se o caminho do worktree tiver algum, ele é omitido.
- Padrões: `parado_min = 15`, checagem de parada a cada `BASTAO_STALL_CHECK_MS` (padrão `60000`).
- Slug válido: `^[a-z0-9][a-z0-9-]*$`.

## Review Focus

1. Slug explícito inválido (`--slug="Meu Ciclo"`) → `init` recusa com mensagem clara antes de criar branch ou worktree. (Task 2)
2. Repositório em pasta com espaço e acento (o `tempRepo` já usa `pasta com espaço é`) → worktree, inferência e mensagem de acordar funcionam. (Tasks 1, 2, 4)
3. Comando rodado numa subpasta do worktree (`.worktrees/x/src`) → infere o ciclo `x`. (Task 1)
4. Branch `ai/<slug>` já em uso na pasta principal (caso real do `eventos`) → `init` falha com mensagem que diz isso, sem deixar estado nem índice para trás. (Task 2)
5. Índice global corrompido ou apontando para repositório apagado → `status --todos` não quebra: corrompido vira aviso, órfão é podado. (Task 6)

---

### Task 0: Verificar o `agentapi send-message` com o Gemini ocupado (manual, com o usuário)

**Files:** Modify: `docs/superpowers/specs/2026-10-27-bastao-multiciclo-design.md` (seção 4, "Risco a verificar primeiro")

- [ ] **Step 1:** Pedir ao usuário uma conversa Gemini descartável no Antigravity e o ID dela. Pedir que ele dê ao Gemini uma tarefa longa (ex.: "rode `Start-Sleep 120` e depois diga OK").
- [ ] **Step 2:** Durante a tarefa, rodar:
  `& "$env:USERPROFILE\.gemini\antigravity-ide\bin\agentapi.bat" send-message --title=Bastao <id> "Bastao: teste, se ja estiver trabalhando, ignore"`
- [ ] **Step 3:** Perguntar ao usuário o que aconteceu: a mensagem entrou na fila depois do turno, ou interrompeu o turno.
- [ ] **Step 4:** Registrar o resultado na spec. Se interromper: o reenvio automático fica desligado (`rewake` nunca é decidido; inatividade gera só `notify`) e a Task 5 usa `canRewake = false`. Commit `docs: resultado do teste do agentapi com conversa ocupada`.

### Task 1: `ciclos.mjs` — onde fica cada ciclo e qual ciclo usar

**Files:**
- Create: `ciclos.mjs`, `ciclos.test.mjs`
- Modify: `test.mjs:18-32` (`runCli` com `BASTAO_INDEX`; `tempRepo` faz commit inicial)

**Interfaces — Produces (todas exportadas de `ciclos.mjs`):**
- `SLUG_RE = /^[a-z0-9][a-z0-9-]*$/`
- `mainRepoOf(dir: string): string` — pai de `git rev-parse --path-format=absolute --git-common-dir`; `BastaoError('NOT_GIT')` fora de git.
- `toplevelOf(dir: string): string` — `git rev-parse --show-toplevel` normalizado.
- `cycleFromToplevel(mainRepo: string, toplevel: string): string | null` — slug se `toplevel` for `<mainRepo>/.worktrees/<slug>`.
- `cyclePaths(mainRepo: string, slug: string, legacy: boolean): { state: string, lock: (agent: string) => string, liveDir: string, worktree: string | null }`
  - novo: `.agents/ciclos/<slug>.json`, `.agents/ciclos/<slug>.wait-<agente>.lock`, `.agents/live/<slug>`, `<mainRepo>/.worktrees/<slug>`
  - legado: `.agents/turn.json`, `.agents/wait-<agente>.lock`, `.agents/live`, `null`
- `listCycles(mainRepo: string): Array<{ slug: string, legacy: boolean }>` — arquivos `.agents/ciclos/*.json` + o legado (slug lido do `turn.json`).
- `resolveCycle({ mainRepo, toplevel, ciclo, explicitRequired }: { mainRepo: string, toplevel: string, ciclo?: string, explicitRequired: boolean }): { slug: string, legacy: boolean, paths: ReturnType<typeof cyclePaths> }`
  - Erros (`BastaoError`): `NO_CYCLE` (nenhum ciclo / `--ciclo` inexistente), `AMBIGUOUS_CYCLE` (mensagem lista os slugs e pede `--ciclo`), `EXPLICIT_CYCLE_REQUIRED` (na pasta principal, ciclo com worktree, `explicitRequired` e sem `--ciclo`; mensagem traz o caminho do worktree).
- `indexPath(): string` — `process.env.BASTAO_INDEX` ou `%USERPROFILE%\.agents\bastao-ciclos.json`.
- `readIndex(): { ciclos: Array<{ repo: string, slug: string, criado_em: string }>, corrupt: boolean }`
- `addToIndex(repo: string, slug: string): void` (idempotente), `removeFromIndex(repo: string, slug: string): void`

- [ ] **Step 1: Ajustar helpers do `test.mjs`.** `runCli` passa `BASTAO_INDEX: path.join(ROOT, 'indice.json')` por padrão. `tempRepo` roda `git -c user.name=t -c user.email=t@t commit --allow-empty -m init` após o `git init` (worktree exige HEAD).
- [ ] **Step 2: Escrever `ciclos.test.mjs` (falhando).** Testes:
  - `cycleFromToplevel` → `'x'` para `<repo>/.worktrees/x`, `null` para `<repo>` e para `<repo>/src`.
  - `resolveCycle` com zero ciclos → `NO_CYCLE`; um ciclo novo + `explicitRequired: false` na raiz → esse ciclo; um ciclo novo + `explicitRequired: true` na raiz → `EXPLICIT_CYCLE_REQUIRED`; dois ciclos sem `ciclo` → `AMBIGUOUS_CYCLE` com os dois slugs na mensagem; `toplevel` dentro de `.worktrees/b` → `b` mesmo com `explicitRequired: true`; legado único na raiz com `explicitRequired: true` → aceito (legado não tem worktree).
  - Subpasta (Review Focus 3): `toplevelOf('<repo>/.worktrees/x/src')` após `git worktree add` real → `cycleFromToplevel` dá `'x'`.
  - Índice: `addToIndex` duas vezes → uma entrada; `removeFromIndex` remove; arquivo com `{quebrado` → `readIndex().corrupt === true` e `ciclos` vazio.
  - Estado escrito à mão em arquivos (`.agents/ciclos/a.json`, `.agents/turn.json` com `slug: 'leg'`) → `listCycles` retorna `[a, leg(legacy)]`.
- [ ] **Step 3:** `node --test ciclos.test.mjs` → FAIL (módulo inexistente).
- [ ] **Step 4:** Implementar `ciclos.mjs` com as assinaturas acima. `resolveCycle` chama `listCycles` e aplica a ordem da spec §2.
- [ ] **Step 5:** `node --test ciclos.test.mjs` → PASS; `node --test test.mjs` → PASS (helpers só ganharam commit e env).
- [ ] **Step 6:** Commit `feat: ciclos.mjs resolve ciclo, caminhos e indice global`.

### Task 2: Estado por ciclo e `init` com worktree

**Files:** Modify: `bastao.mjs` (`initState`, `readState`, `writeState`, `ensureExclude`, `main` → `init`), `test.mjs`

**Interfaces:**
- Consumes: `SLUG_RE`, `mainRepoOf`, `toplevelOf`, `cyclePaths`, `listCycles`, `resolveCycle`, `addToIndex` (Task 1).
- Produces:
  - `readState(file: string): Promise<object | null>` e `writeState(file: string, state: object): void` (tmp = `file + '.tmp'`; cria a pasta).
  - `normalizeState(s: object): object` — preenche `seq ?? history.length`, `wake ?? null`, `parado_min ?? 15`, `stall ?? null`, `worktree ?? null`; `version: 3`.
  - `initState({..., worktree, paradoMin})` grava `version: 3`, `seq: 0`, `worktree` (relativo, `.worktrees/<slug>`), `parado_min`, `wake: null`, `stall: null`.
  - `ensureExclude(repo)` acrescenta `.agents/ciclos/` e `.worktrees/` às linhas atuais.
  - `function ctx(rest, { explicitRequired }): { mainRepo, toplevel, cycle }` em `bastao.mjs` — usado por todos os comandos de ciclo a partir da Task 3.

- [ ] **Step 1: Adaptar `test.mjs` ao novo layout (falhando).** Helpers novos: `estadoDe(repo, slug)` lê `.agents/ciclos/<slug>.json`; `cli(repo, slug, args, env)` = `runCli([...args, `--repo=${repo}`, `--ciclo=${slug}`], repo, env)`. Os testes que leem `.agents/turn.json` passam a usar `estadoDe`; os que dão `init` sem `--slug` passam `--slug`. Reescrever `segundo init com ciclo ativo falha` como `init: mesmo slug falha, slug diferente cria segundo ciclo e segundo worktree`. Novos testes:
  - `init cria .worktrees/<slug> na branch ai/<slug>, grava estado v3 e registra no índice` (confere `git -C <wt> branch --show-current`, `state.worktree === '.worktrees/<slug>'`, entrada em `BASTAO_INDEX`, exclude com `.worktrees/` e `.agents/ciclos/`).
  - `init reaproveita branch ai/<slug> existente`.
  - `init recusa slug inválido sem criar nada` (`--slug="Meu Ciclo"` → status 1, nenhuma branch nova, nenhum `.agents/ciclos/`).
  - `init falha claro quando ai/<slug> está em uso na pasta principal` (`git checkout -b ai/x` na raiz → status 1, stderr cita `ai/x` e "em uso", sem estado e sem entrada no índice).
  - `init avisa spec/plano ausentes no worktree e config sem .worktrees` (criar `vitest.config.ts` vazio commitado → stdout cita `vitest.config.ts`; `--spec=docs/nao.md` → stdout cita `docs/nao.md`).
- [ ] **Step 2:** `node --test test.mjs` → FAIL nos testes novos e adaptados.
- [ ] **Step 3: Implementar.** `init`: valida `SLUG_RE` (slug derivado da task também); recusa slug existente sem `--force`; `git worktree add .worktrees/<slug> ai/<slug>` se a branch existir, senão `git worktree add -b ai/<slug> .worktrees/<slug> <--base ou HEAD>`; falha do git → `BastaoError` com a saída do git (antes de gravar estado); depois grava estado, `addToIndex`, avisos (spec/plano via `fs.existsSync` no worktree; configs da raiz que existam e não contenham `.worktrees`) e imprime caminho + `npm install`. Flags novas: `--ciclo`, `--base`, `--parado-min`.
- [ ] **Step 4:** `node --test test.mjs ciclos.test.mjs` → PASS (comandos de ciclo ainda serão ajustados na Task 3; testes de `pass`/`wait` que dependem dela podem ficar vermelhos até lá — anotar quais no commit).
- [ ] **Step 5:** Commit `feat: init cria worktree por ciclo e estado v3`.

### Task 3: Comandos no ciclo resolvido (pass, ask, pause, wait, status, _codex) e legado

**Files:** Modify: `bastao.mjs` (`main`, `_codex`, `formatInstructions`), `test.mjs`

**Interfaces:**
- Consumes: `ctx` e `readState/writeState(file)` (Task 2).
- Produces: `applyPass`/`applyAsk`/`applyPause` incrementam `seq`; `formatInstructions(state, { repoName, worktreeAbs })` acrescenta `Ciclo: <slug> (<repo>)` e `Workspace: <worktreeAbs>` (omitida no legado); notificações passam a começar por `<repo>/<slug>`.

- [ ] **Step 1: Testes (falhando).**
  - `pass em um ciclo não altera o outro` (dois ciclos; `cli(a, pass)`; estado de `b` byte a byte igual).
  - `comando dentro do worktree infere o ciclo sem --ciclo` (cwd `.worktrees/a/sub` criado; `pass` sem `--ciclo` e sem `--repo` → status 0 no ciclo `a`).
  - `na pasta principal pass e wait exigem --ciclo; status lista os ciclos` (um ciclo com worktree: `pass` sem `--ciclo` → 1, stderr cita `.worktrees/`; `status` sem `--ciclo` com dois ciclos → 0 e stdout com os dois slugs).
  - `legado: turn.json existente segue funcionando com lock antigo ao lado de um ciclo novo` (escrever `turn.json` v2 à mão com `slug: 'leg'`; `cli(repo, 'leg', pass)` → grava em `turn.json` com `seq`; `wait --for=claude --ciclo=leg` com `.agents/wait-claude.lock` vivo do próprio teste (pid atual) → sai 4).
  - `codex usa o worktree e grava log em .agents/live/<slug>/codex.log` (adaptar o teste de codex existente: o fake grava `process.cwd()`; deve ser o worktree).
- [ ] **Step 2:** `node --test test.mjs` → FAIL.
- [ ] **Step 3: Implementar.** Todos os comandos usam `ctx`: `explicitRequired: true` em `pass`, `ask`, `wait`; `false` em `status`, `pause`, `_codex` (o `_codex` recebe `--ciclo` do `pass`). `status` sem ciclo resolvido (`AMBIGUOUS_CYCLE`) imprime uma linha por ciclo (`slug · vez de · ação · status`). `_codex`: `-C` e `cwd` = worktree (ou raiz no legado); log em `paths.liveDir`. Locks via `paths.lock(agent)`.
- [ ] **Step 4:** `node --test test.mjs ciclos.test.mjs` → PASS (todos, inclusive os anotados na Task 2).
- [ ] **Step 5:** Commit `feat: comandos operam no ciclo resolvido, com legado e guarda de --ciclo`.

### Task 4: O `pass` acorda o Gemini; `--wake` obrigatório

**Files:** Modify: `bastao.mjs` (`pass`, `wait`, `sendAgentApiMessage` chamadores), `test.mjs`

**Interfaces:**
- Produces: `wakeText(state, { repoName, worktreeAbs, rewake }: {...}): string` — exata:
  `Bastao: sua vez no ciclo <slug> (<repo>). Workspace: <worktree>. Rode: bastao status --ciclo=<slug> e siga a skill bastao.`
  com `rewake` acrescenta ` Se ja estiver trabalhando, ignore.`; sem ` Workspace: ...` no legado ou se o caminho tiver `& | < > ^ " %`.
  `wakeGemini(file: string, state: object, opts): boolean` — envia, grava `wake = { seq, at, ok }` e evento `wake`/`wake_failed` no histórico.

- [ ] **Step 1: Testes (falhando).**
  - `pass para gemini com conversa registrada acorda na hora` (estado com `conversations.gemini = 'conv-1'`; `cli pass --to=gemini` com fake agentapi → log tem `conv-1` e o texto exato; `state.wake.seq === state.seq`, `ok: true`).
  - `pass para gemini sem conversa avisa o usuário` (`BASTAO_NOTIFY` = arquivo: mudar `notify` para, quando `BASTAO_NOTIFY` não for `off` nem vazio e terminar em `.log`, anexar o texto ao arquivo — só para teste; stdout/arquivo contém `<repo>/<slug>` e `retome o bastão <slug>`).
  - `vigia do gemini não reenvia na mesma passagem` (após o pass que acordou, `wait --for=gemini --wake=conv-1` sai 0 e o log do fake continua com uma linha).
  - `wait --for=gemini sem --wake falha` (status 1, stderr cita `--wake`).
  - Adaptar `wait: agentapi .bat em pasta com espaço...` ao texto novo (com `Workspace:` contendo espaço e acento).
- [ ] **Step 2:** `node --test test.mjs` → FAIL.
- [ ] **Step 3:** Implementar `wakeText`, `wakeGemini`, chamada no `pass` quando `current_turn === 'gemini' && status === 'IN_PROGRESS'`; no `wait`, só enviar se `wake?.seq !== state.seq || !wake.ok`; validação de `--wake` obrigatório para `gemini`.
- [ ] **Step 4:** `node --test test.mjs ciclos.test.mjs` → PASS.
- [ ] **Step 5:** Commit `feat: pass acorda o gemini e wait do gemini exige --wake`.

### Task 5: Detector de parada

**Files:** Create: `parada.mjs`, `parada.test.mjs`. Modify: `bastao.mjs` (loop do `wait`, `status`), `test.mjs`

**Interfaces — Produces (`parada.mjs`):**
- `lastActivity({ dir, branch, state }: { dir: string, branch: string, state: object }): number` — ms; máximo entre mtimes de `git -C dir status --porcelain -uall` (ignora caminhos que sumiram), `git log -1 --format=%ct <branch>` × 1000 e `Date.parse` do último evento do histórico.
- `decideStall(state, { now, activityMs, canRewake }): { action: 'none' | 'clear' | 'rewake' | 'notify', stall: object | null }` — puro. Limite `L = parado_min * 60000`; `idle = now - activityMs`.
  - status ≠ `IN_PROGRESS` ou dono `human` → `none`, `stall` inalterado.
  - `stall` existe e `activityMs > Date.parse(stall.since)` → `clear`, `stall: null`.
  - `idle < L` → `none`.
  - `idle ≥ L`, sem `stall`: `canRewake` → `rewake`, `stall = { since: now - idle, rewake_at: now, notified_at: null }`; senão `notify`, `stall = { since, rewake_at: null, notified_at: now }`.
  - `idle ≥ 2L`, `stall.rewake_at` e sem `notified_at` → `notify`, grava `notified_at`.
  - demais → `none`.
- `isParado(state): boolean` — `!!state.stall?.notified_at`.

- [ ] **Step 1: `parada.test.mjs` (falhando).** Tabela de casos de `decideStall` cobrindo cada linha acima (gemini com e sem `canRewake`, claude, human, APPROVED, limpeza ao voltar atividade, idempotência: segunda chamada após `notify` → `none`). `lastActivity` num repo temporário: arquivo modificado recente domina commit antigo; arquivo apagado listado pelo git não quebra.
- [ ] **Step 2:** `node --test parada.test.mjs` → FAIL.
- [ ] **Step 3:** Implementar `parada.mjs`.
- [ ] **Step 4: Integração (teste em `test.mjs`, falhando primeiro).** `vigia do claude reacorda o gemini parado uma vez e depois avisa`: ciclo com `--parado-min=0.01`, conversa gemini registrada, pass para gemini; `wait --for=claude` em background com `BASTAO_STALL_CHECK_MS=100`; após ~2 s: fake agentapi com 2 mensagens (acordar + reacordar com "ignore"), `state.stall.notified_at` preenchido, arquivo de notificação com `<repo>/<slug>` uma única vez; `status --ciclo` mostra `PARADO`.
- [ ] **Step 5:** No loop do `wait`, a cada `BASTAO_STALL_CHECK_MS`, reler estado, calcular `lastActivity` (dir = worktree ou raiz; branch = `state.branch`), `decideStall` com `canRewake = current_turn === 'gemini' && !!conversations.gemini` (forçar `false` se a Task 0 concluiu que interrompe); aplicar: `rewake` → `wakeGemini(..., { rewake: true })`; `notify` → `notify('[PARADO] <repo>/<slug>: <dono> sem atividade há <n> min')`; gravar `stall` se mudou. `pass` aceita `--parado-min=<n>` e grava em `state.parado_min`. `status` exibe `Com <dono> há <n> min`, vigias vivos (`isLockAlive` de cada agente), `Acordável: sim/não` e `PARADO` (calculado na hora se não houver vigia, sem gravar).
- [ ] **Step 6:** `node --test test.mjs ciclos.test.mjs parada.test.mjs` → PASS.
- [ ] **Step 7:** Commit `feat: detector de parada no vigia e no status`.

### Task 6: `status --todos` e `fim`

**Files:** Modify: `bastao.mjs` (`status`, novo `fim`, `--help`), `test.mjs`

**Interfaces:** Consumes `readIndex`, `removeFromIndex`, `listCycles`, `cyclePaths`, `isParado`, `lastActivity` (Tasks 1, 5).

- [ ] **Step 1: Testes (falhando).**
  - `status --todos lista ciclos de dois repos e poda órfão` (dois repos com um ciclo cada; entrada extra no índice para pasta inexistente → stdout com os dois `<repo>/<slug>`, índice sem o órfão).
  - `status --todos com índice corrompido avisa e não quebra` (status 0, stdout cita o caminho do índice).
  - `fim recusa worktree com alteração não commitada` (arquivo novo no worktree → status 1, worktree e estado intactos).
  - `fim remove worktree limpo, estado e entrada do índice, mantendo a branch`.
  - `fim recusa com vigia vivo` (lock com pid atual → status 1).
  - `fim no legado apaga turn.json`.
- [ ] **Step 2:** `node --test test.mjs` → FAIL.
- [ ] **Step 3:** Implementar. `status --todos` não exige repositório git no cwd. Linha: `<repo>/<slug> · vez de <dono> (<ação>) há <n> min · vigias: <lista|nenhum> · acordável: sim|não[ · PARADO]`. `fim`: `ctx` com `explicitRequired: true`; recusa lock vivo; `git worktree remove <wt>` (sem `--force`; erro do git vira `BastaoError` com a saída); apaga o estado; `removeFromIndex`. `--help` lista `fim` e `--ciclo`/`--todos`.
- [ ] **Step 4:** `node --test test.mjs ciclos.test.mjs parada.test.mjs` → PASS.
- [ ] **Step 5:** Commit `feat: status --todos e comando fim`.

### Task 7: Skill e READMEs

**Files:** Modify: `SKILL.md`, `README.md`, `README.pt-BR.md`

- [ ] **Step 1:** `SKILL.md` conforme spec §5: seção "Ciclos e worktrees" (`--ciclo`, inferência pela pasta, implementador confere `git rev-parse --show-toplevel` = worktree antes de editar, `npm install` no worktree); "Ao entrar ou retomar" com `bastao status` e, se listar vários, perguntar qual ou usar o nome dado; Gemini sempre `--wake`; `bastao status --todos`; `fim` só com ok do usuário após o merge; linha de erro de ciclo ambíguo/`--ciclo` exigido na tabela do `wait` (código 1). Exemplos de comando com `--ciclo=<slug>`.
- [ ] **Step 2:** READMEs: seção curta "Vários ciclos" com o mesmo conteúdo para humanos e a nota sobre ignorar `.worktrees/**` no vitest/eslint/tsconfig dos repositórios.
- [ ] **Step 3:** `node --test test.mjs ciclos.test.mjs parada.test.mjs` → PASS; `node bastao.mjs --help` mostra `fim`, `--ciclo`, `--todos`.
- [ ] **Step 4:** Commit `docs: skill e README para multiciclo`.

### Task 8: Entrega (com ok do usuário)

- [ ] **Step 1:** Revisão final da branch inteira contra a spec.
- [ ] **Step 2:** Com ok do usuário: merge de `feat/multiciclo` no `master` do repositório do bastão, testes de novo no `master`, `node bastao.mjs install --yes` (recopia a skill para Claude, Gemini e Codex), `git worktree remove .worktrees/multiciclo`.
- [ ] **Step 3:** Conferir que os vigias legados de `eventos` e `SISTEMA_PRODUCAO`, se ainda vivos, continuam funcionando (`bastao status --ciclo=<slug> --repo=<repo>` lê o `turn.json`).
- [ ] **Step 4:** Relatar ao usuário a lista de repositórios que precisam do commit de ignorar `.worktrees/**` antes do primeiro ciclo com worktree (fica fora desta branch; cada um segue as regras do próprio repositório e precisa de ok).
