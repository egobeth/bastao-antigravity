# Bastão multiciclo — design

Data: 2026-10-27 · Status: aprovado em conversa, aguardando revisão da spec escrita

## 1. Objetivo

Permitir vários bastões ao mesmo tempo, sem interferência:

- vários ciclos no **mesmo repositório** (ex.: dois no GESTAO, cada um numa seara);
- ciclos em **repositórios diferentes** (GESTAO, eventos, chatbot-marisete...), o que já funciona hoje e passa a
  ser visível num painel único.

E acabar com o bastão "engatado": hoje, se o Gemini não armou o vigia com `--wake` ou parou no meio do turno,
nada percebe e o ciclo fica parado até alguém notar.

### Evidência que motivou a parte de robustez (2026-10-26)

- `eventos`: Gemini tinha `conversations.gemini` registrado; o Claude passou às 21:00:32 e o Gemini acordou em
  menos de 1 min.
- `SISTEMA_PRODUCAO`: `conversations.gemini` vazio — o Gemini nunca armou `wait --wake`. O Claude passou às
  20:20 e o ciclo ficou ~40 min parado até intervenção manual. Nada no estado indicava o engate.

### Critérios de sucesso

1. Dois ciclos no mesmo repositório andam em paralelo, cada um em seu worktree, sem que um comando de um ciclo
   altere o outro.
2. Nenhum comando age sobre um ciclo escolhido por acaso: com mais de um ciclo e nenhum indicado, o comando
   falha e lista os ciclos.
3. Ao passar o bastão para o Gemini, ele é acordado pelo próprio `pass`; se não for possível, o usuário é avisado
   na hora.
4. Um dono de bastão sem atividade por N minutos é reacordado uma vez (Gemini) e, persistindo, o usuário é
   avisado e o `status` mostra PARADO.
5. Os ciclos em andamento no formato antigo (`.agents/turn.json`) terminam sem interrupção, inclusive com os
   vigias da versão anterior que já estão rodando.

### Fora de escopo

- Passar automaticamente para outro implementador quando alguém para (opção "c", descartada).
- Rodar `npm install` no worktree (o `init` só imprime o comando).
- Coordenação entre máquinas diferentes.

## 2. Ciclos e estado

### Arquivos (na pasta principal do repositório)

| O quê | Caminho |
|---|---|
| Estado de um ciclo | `.agents/ciclos/<slug>.json` |
| Vigia de um agente no ciclo | `.agents/ciclos/<slug>.wait-<agente>.lock` |
| Log do Codex do ciclo | `.agents/live/<slug>/codex.log` |
| Worktree do ciclo | `.worktrees/<slug>` (branch `ai/<slug>`) |
| Índice global (todos os repos) | `%USERPROFILE%\.agents\bastao-ciclos.json` |

A pasta principal é obtida por `git rev-parse --path-format=absolute --git-common-dir` (pai do `.git`), então o
mesmo estado é visto de dentro de qualquer worktree. O `ensureExclude` passa a incluir `.agents/ciclos/`,
`.agents/live/` e `.worktrees/` em `.git/info/exclude`.

### Estado (versão 3)

Mantém os campos atuais e acrescenta:

- `worktree`: caminho relativo à pasta principal (`.worktrees/<slug>`) ou `null` no ciclo legado.
- `seq`: número da passagem, incrementado a cada `pass`/`ask`/`pause`.
- `wake`: `{ seq, at, ok }` — última mensagem de acordar enviada e para qual passagem.
- `parado_min`: limite de inatividade (padrão 15).
- `stall`: `null` ou `{ since, rewake_at, notified_at }`.

### Ciclo legado

Um `.agents/turn.json` existente **não é movido**: é tratado como um ciclo cujo nome é o seu `slug`, com
`worktree: null`, lido e gravado no mesmo lugar e com os locks no caminho antigo (`.agents/wait-<agente>.lock`).
Motivo: os vigias da versão anterior em execução leem `turn.json` e checam esses locks; mover o arquivo os
deixaria cegos por até 4 h. Os campos novos são acrescentados ao gravar. Quando o ciclo legado é encerrado com
`fim`, o `turn.json` é apagado. Novos ciclos nunca usam `turn.json`.

### Qual ciclo um comando usa

1. `--ciclo=<slug>` explícito.
2. Comando rodando dentro de `.worktrees/<slug>` → esse ciclo.
3. Na pasta principal com um único ciclo ativo (contando o legado) → esse ciclo.
4. Senão: erro `AMBIGUOUS_CYCLE` listando os ciclos e pedindo `--ciclo`.

`status` sem ciclo resolvido não falha: lista o resumo dos ciclos do repositório.

Guarda contra trabalhar no lugar errado: na pasta principal, `pass`/`ask`/`wait` de um ciclo **com worktree**
exigem `--ciclo` explícito (a regra 3 não vale para eles). Assim, uma sessão aberta na pasta principal (ex.: o
Claude que escreveu a spec) ainda pode operar o ciclo, mas nunca por inferência. As instruções impressas por
`status`, `wait` e pela mensagem de acordar sempre trazem o caminho do worktree.

## 3. Comandos

Todos aceitam `--ciclo=<slug>` além de `--repo=<dir>`.

- **`init`** `--task --spec --plan [--slug] [--base=<ref>] [--parado-min=15] ...`
  - Falha se já existir ciclo com o mesmo slug (sem `--force`). Não falha mais por existir outro ciclo.
  - Cria `.worktrees/<slug>`: usa a branch `ai/<slug>` se existir; senão cria a partir de `--base` (padrão: HEAD
    da pasta principal).
  - Confere se `--spec` e `--plan` existem dentro do worktree; se não, avisa que precisam estar commitados na
    base.
  - Avisa se `vitest.config.*`, `vite.config.*`, `eslint.config.*` ou `tsconfig*.json` da raiz existirem e não
    mencionarem `.worktrees`.
  - Registra `{repo, slug}` no índice global e imprime o caminho do worktree e `npm install` a rodar lá.
- **`status`** — o ciclo resolvido (como hoje, mais worktree, há quanto tempo está com o dono, vigias vivos,
  se o dono é acordável e PARADO); sem ciclo resolvido, o resumo do repositório.
- **`status --todos`** — uma linha por ciclo de todos os repositórios do índice: repo, ciclo, dono, ação, há
  quanto tempo, vigias, acordável, PARADO. Entradas cujo estado sumiu são removidas do índice.
- **`pass`, `ask`, `pause`, `wait`** — como hoje, no ciclo resolvido, com as mudanças da seção 4.
- **`fim`** (novo) — só com ok do usuário. Remove o worktree (recusa se houver alteração não commitada; nunca
  usa `--force` do git), apaga o estado do ciclo e a entrada do índice. A branch fica.
- **`_codex`** — roda com `-C <worktree>` e cwd no worktree (ou na raiz, no legado); log por ciclo.

## 4. Acordar e detectar parada

### O `pass` acorda quem recebe

- `pass --to=gemini`: se `conversations.gemini` existir, o `pass` envia na hora a mensagem de acordar e grava
  `wake = {seq, at, ok}` e um evento no histórico. Se não existir ou o envio falhar, `notify` ao usuário:
  `[BASTAO] <repo>/<slug>: vez do gemini, mas não consigo acordá-lo. Abra o Gemini em <worktree> e diga "retome o bastão <slug>".`
- Mensagem: `Bastao: sua vez no ciclo <slug> (<repo>). Workspace: <worktree>. Rode: bastao status --ciclo=<slug> e siga a skill bastao.`
  O caminho é omitido se contiver caractere proibido pelo `cmd` (`& | < > ^ " %`).
- O vigia do Gemini continua como reserva: ao ver que é a vez dele, só envia a mensagem se `wake.seq` for
  diferente do `seq` atual ou `wake.ok` for falso.
- `wait --for=gemini` sem `--wake` → erro `INVALID_ARGS`.
- Claude (só o próprio vigia o acorda) e Codex (iniciado pelo `pass`) não mudam.
- Toda notificação ao usuário passa a trazer `<repo>/<slug>`.

### Detector de parada

- Todo `wait` vivo do ciclo verifica a cada 60 s (`BASTAO_STALL_CHECK_MS` nos testes) a última atividade do
  dono do bastão, se o status for `IN_PROGRESS`.
- Atividade = maior entre: mtime dos arquivos listados por `git status --porcelain` no worktree (raiz, no
  legado), data do último commit de `ai/<slug>` e data do último evento do histórico.
- Inatividade ≥ `parado_min`:
  - dono `gemini` com conversa registrada e `stall.rewake_at` vazio → reenvia a mensagem de acordar uma vez,
    com o texto "se já estiver trabalhando, ignore", e grava `stall.rewake_at`;
  - outros casos → `notify` e grava `stall.notified_at`.
- Inatividade ≥ 2 × `parado_min` com `rewake_at` gravado e `notified_at` vazio → `notify` e grava `notified_at`.
- Atividade mais nova que `stall.since` → `stall = null`.
- Um aviso por parada. `status` mostra **PARADO** quando `stall.notified_at` existe.
- Sem vigia vivo, `status`/`status --todos` calculam a inatividade na hora (só exibem, não gravam nem enviam).
- Corrida entre dois vigias do mesmo ciclo é tolerada: no pior caso, duas mensagens.

### Risco a verificar primeiro

Não se sabe o que `agentapi send-message` faz com uma conversa do Gemini que está no meio de um turno. Primeira
tarefa do plano: testar com o usuário. Se a mensagem for enfileirada, o desenho acima vale. Se interromper o
turno, o reenvio automático é desligado e a inatividade só gera aviso ao usuário.

## 5. Skill (SKILL.md)

- Explicar ciclos, worktree e `--ciclo`; o implementador confirma que `git rev-parse --show-toplevel` é o worktree
  antes de editar.
- "Retome o bastão": rodar `bastao status`; se listar vários ciclos, perguntar ao usuário qual (ou usar o nome
  que ele deu).
- Gemini: `wait` sempre com `--wake=<id>`.
- `fim` só com ok do usuário, depois do merge.
- Tabela de saídas do `wait` ganha o erro de ciclo ambíguo.

## 6. Testes (`test.mjs`, node:test)

- Dois ciclos no mesmo repo: `init` cria dois worktrees; `pass` em um não altera o outro.
- Resolução: por `--ciclo`, por cwd dentro do worktree, ciclo único na raiz, erro com vários; guarda de `--ciclo`
  explícito na raiz.
- Legado: `turn.json` existente continua funcionando no lugar, com lock antigo, convivendo com ciclo novo.
- `pass --to=gemini` acorda via `BASTAO_AGENTAPI` falso; sem conversa → notificação; vigia não reenvia na mesma
  passagem.
- `wait --for=gemini` sem `--wake` falha.
- Detector: reenvio uma vez, aviso no dobro do tempo, limpeza ao voltar atividade (limites curtos por env).
- `status --todos` lista ciclos de dois repos e poda entrada órfã.
- `fim` recusa worktree sujo e remove o limpo.
- Os testes atuais continuam passando.

## 7. Implantação

1. Implementar em `feat/multiciclo` (worktree `.worktrees/multiciclo` do repositório do bastão), `node --test`
   passando, merge no `master` com ok do usuário e `bastao install --yes` para recopiar a skill.
2. Em cada repositório, antes do primeiro ciclo com worktree: commit (seguindo as regras daquele repositório)
   que faz vitest, eslint e tsconfig ignorarem `.worktrees/**`.
3. Os ciclos legados de `eventos` e `SISTEMA_PRODUCAO` terminam como estão.
