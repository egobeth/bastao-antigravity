---
name: bastao
description: Use quando o usuário pedir para entrar no bastão, retome o bastão, status do bastão, passar o bastão ou coordenar o handoff multi-agente entre Claude, Gemini e Codex.
---

# Protocolo do Bastão

Protocolo de passagem de turno e handoff conversacional contínuo entre Claude Code, Gemini (Antigravity) e Codex.

## 1. Princípios Gerais

- **Vários ciclos ao mesmo tempo:** cada repositório pode ter vários bastões (ciclos), cada um com seu nome (`slug`), sua branch `ai/<slug>` e seu **worktree** `<repo>/.worktrees/<slug>`. Repositórios diferentes também têm ciclos independentes.
- **Fonte da verdade:** `.agents/ciclos/<slug>.json` na pasta principal do repositório. Ciclos antigos (`.agents/turn.json`) continuam funcionando até serem encerrados, sem worktree.
- **Divisão padrão de papéis:**
  - Claude: especificação, planejamento e revisão.
  - Gemini: implementação (maior cota de contexto).
  - Codex: implementação ou revisão complementar via `exec resume`.
- **Onde trabalhar:** só no worktree do ciclo. A pasta principal fica com o usuário e o `master`/`main`; nunca edite nem faça commits nela. Antes de editar, confirme que `git rev-parse --show-toplevel` é o worktree do ciclo. Na primeira vez no worktree, rode `npm install` (ou o equivalente) lá.
- **Proibições sem autorização explícita do usuário:** merge, push, deploy, apagar branches, `bastao fim` e alterar arquivos fora do repositório.

## 2. Qual ciclo

- Dentro de `.worktrees/<slug>` (ou subpasta), o ciclo é deduzido; não precisa de `--ciclo`.
- Na pasta principal, `pass`, `ask`, `wait` e `fim` exigem `--ciclo=<slug>`. Com mais de um ciclo e nenhum indicado, os comandos falham listando os ciclos; `status` lista o resumo de cada um.
- `bastao status --todos` mostra todos os ciclos de todos os repositórios: dono, há quanto tempo, vigias, se dá para acordar o dono e **PARADO**.
- Nos exemplos abaixo, `--ciclo=<slug>` pode ser omitido quando você estiver dentro do worktree.

## 3. Regras por Agente

### Claude Code
- Ao esperar sua vez: execute `bastao wait --for=claude --ciclo=<slug>` com `run_in_background`. Quando o comando terminar, sua sessão será reativada automaticamente.

### Gemini (Antigravity)
- Ao esperar sua vez: execute `bastao wait --for=gemini --ciclo=<slug>` em segundo plano, **num terminal do Antigravity**, e encerre seu turno. O vigia lê seu Conversation ID de `ANTIGRAVITY_CONVERSATION_ID` e guarda no seu perfil o endereço e o token do Antigravity, para o `pass` do Claude e do Codex conseguirem te acordar. Fora do Antigravity, passe `--wake=<id>`.
- Rearme o vigia a cada turno: se o Antigravity reiniciar, o token muda e só o vigia grava o novo.
- Uma conversa por ciclo. Numa conversa nova ("retome o bastão"), o `wait` com o novo ID substitui o antigo.
- A mensagem de acordar diz o ciclo e o workspace: abra/use esse worktree.

### Codex
- **Nunca arma vigia.** O Codex é acionado diretamente pelo comando `bastao pass --to=codex` e roda no worktree do ciclo; encerra sua execução assim que passar o bastão.
- A saída do Codex fica em `.agents/live/<slug>/codex.log`, com um separador `=== Round r/m · <ação> · HH:MM ===` por turno.
- O processo `_codex` mantém um lock de heartbeat (`.agents/ciclos/<slug>.wait-codex.lock`) enquanto roda, faz **1 retry automático** via `resume` se encerrar sem passar o bastão (antes de cair em `WAITING_HUMAN`), e é **relançado automaticamente** por qualquer vigia ativo (`bastao wait`) se o Job Object do terminal do `pass` o encerrar. Sem vigia ativo, relançar manualmente continua seguro (o `_codex` não faz nada se já houver lock vivo ou não for a vez do Codex): `node $env:USERPROFILE\.agents\bastao\bastao.mjs _codex --repo=<pasta principal> --ciclo=<slug>`.
- Se o Codex terminar (inclusive após o retry automático) sem passar o bastão, o ciclo vai para `WAITING_HUMAN` com a pergunta automática. Para responder, qualquer IA no chat roda, a pedido do usuário:
  `bastao pass --from=human --to=codex --action=<ação> --force --ciclo=<slug> --notes="<resposta do usuário>"`

### Acordar e parada
- `bastao pass --to=gemini` acorda o Gemini na hora pela conversa registrada. Se o envio inicial falhar (`wake.ok === false`), qualquer vigia ativo retenta automaticamente no próximo ciclo de checagem (~60 s). Sem conversa registrada, o usuário é avisado para abrir o Gemini no worktree e dizer "retome o bastão <slug>".
- Os vigias observam o dono do bastão: contam como atividade arquivos alterados no worktree, commits, passagens e a escrita em `.agents/live/<slug>/codex.log`. Sem atividade por `1/5` de `parado_min` (3 min no padrão de 15 min, ajustável com `--parado-min` no `init` ou no `pass`), o Gemini acordável recebe uma nova mensagem ("se já estiver trabalhando, ignore") e, persistindo até `parado_min` (15 min), o usuário é avisado e o `status` mostra PARADO.
- Recebeu uma mensagem de reacordar e já está trabalhando? Ignore e siga.

### Saídas do `wait`
| Código | O que fazer |
|---|---|
| 0 | é sua vez: siga as instruções impressas |
| 1 | erro: leia a mensagem (ex.: falta `--ciclo`, falta `--wake` no Gemini fora do Antigravity, ciclo inexistente) e corrija o comando |
| 2 | tempo esgotado: arme o `wait` de novo |
| 3 | ciclo `APPROVED`, `MAX_ROUNDS_REACHED` ou `MANUAL_PAUSE`: rode `bastao status` e avise o usuário; não rearme |
| 4 | já existe vigia vivo para você neste ciclo: não arme outro |
| 5 | falha ao acordar o Gemini: avise o usuário |

## 4. Fluxo de Trabalho

### Iniciar um ciclo (Claude, depois que o usuário aprovar spec e plano)
Spec e plano precisam estar commitados na base (o worktree nasce dela).

`bastao init --task="<tarefa>" --slug=<slug> --spec=<caminho> --plan=<caminho> [--base=<ref>] [--implement=gemini] [--review=claude,codex] [--max-rounds=3] [--parado-min=15] [--codex-thread=<id>]`

O `init` cria `.worktrees/<slug>` na branch `ai/<slug>` (reaproveita a branch se existir) e imprime o caminho. Leia os avisos: spec/plano ausentes no worktree, ou `vitest`/`eslint`/`tsconfig` que não ignoram `.worktrees/` (avise o usuário; ignorar `.worktrees/**` é um commit à parte, com ok dele).

Depois, `bastao pass --from=claude --to=<implementador> --action=implement --ciclo=<slug> --notes="<resumo>"`. Papéis e skills mudam a qualquer momento com `--roles=implement:codex,review:claude+gemini` e `--skills=a,b` no `pass`. O usuário assume o controle com `bastao pause --ciclo=<slug>` e devolve com `bastao pass --from=human --to=<agente> --action=<ação> --ciclo=<slug>`.

### Ao entrar ou retomar
1. Execute `bastao status` (no worktree do ciclo, ou com `--ciclo=<slug>`). Se ele listar vários ciclos, use o nome que o usuário deu ou pergunte qual.
2. Se for a sua vez (`Vez de: <seu-nome>`), realize o trabalho correspondente no `Workspace:` indicado.
3. Se não for sua vez, arme o vigia conforme as regras do seu agente e encerre o turno.

### Turno de Implementação (`implement`)
1. Leia a spec (`Spec:`), o plano (`Plano:`), as notas (`Notas:`) e as skills ativas. Na rodada 2+, leia também a evidência de revisão anterior (`docs/evidence/<data>-<slug>-review-<N-1>.md`).
2. Garanta que está no worktree do ciclo, na branch `ai/<slug>`.
3. Implemente as alterações e execute todos os testes e comandos de validação especificados.
4. Faça commit das alterações na branch.
5. Registre a evidência em `docs/evidence/<data>-<slug>-impl-<N>.md`:
   - O que foi feito (itens do plano).
   - Arquivos alterados e commits.
   - Saída real dos testes de verificação.
   - Desvios ou pendências.
6. Passe o bastão:
   `bastao pass --from=<eu> --to=<revisor> --action=review --evidence=docs/evidence/<data>-<slug>-impl-<N>.md --notes="<resumo>"`
7. Arme o vigia e encerre seu turno.

### Turno de Revisão (`review`)
1. Analise o trabalho com base na spec, plano, evidência de implementação e diff da branch (no worktree). Execute testes se necessário.
2. Escreva seus apontamentos em `docs/evidence/<data>-<slug>-review-<N>.md` no formato padronizado:
   ```markdown
   Veredito: APROVADO | CORRIGIR (n bloqueantes, n importantes)

   ### 🔴 [BLOQUEANTE] caminho/arquivo.ext:84
   - **Problema:** Descrição clara do problema
   - **Correção esperada:** O que deve ser alterado

   ### 🟡 [IMPORTANTE] caminho/arquivo.ext:120
   - **Problema:** Descrição do problema
   - **Correção esperada:** O que deve ser alterado

   ### 🔵 [SUGESTÃO] caminho/arquivo.ext:200
   - **Problema:** Sugestão de melhoria
   - **Correção esperada:** Detalhes da sugestão
   ```
3. Se houver mais revisores após você em `roles.review`:
   Passe para o próximo sem veredito final:
   `bastao pass --from=<eu> --to=<proximo-revisor> --action=review --notes="Revisão parcial feita por <eu>"`
4. Se você for o último revisor:
   - Se houver qualquer achado bloqueante ou importante: veredito `CORRIGIR`.
     `bastao pass --from=<eu> --to=<implementador> --action=fix --evidence=docs/evidence/<data>-<slug>-review-<N>.md --notes="Correções solicitadas na rodada N"`
   - Se tudo estiver correto: veredito `APROVADO`.
     `bastao pass --from=<eu> --to=human --action=done --evidence=docs/evidence/<data>-<slug>-review-<N>.md --notes="Aprovado"`
     Alerte o usuário no chat e não arme o vigia.

### Dúvidas (`ask`)
- Se encontrar ambiguidades impeditivas, contradições ou necessidade de decisão humana:
  Execute `bastao ask --from=<eu> --question="<pergunta objetiva>"`
  Apresente a pergunta no chat e encerre o turno sem armar o vigia.
- Quando o usuário responder no chat, continue o turno normalmente e passe o bastão com `bastao pass ...`.

### Encerrar (`fim`)
- Só com ok explícito do usuário, depois do merge: `bastao fim --ciclo=<slug>`. Remove o worktree (recusa se houver alteração não commitada ou vigia vivo), apaga o estado do ciclo e o tira do `status --todos`. A branch fica.

## 5. Pré-requisitos e Execução Automática
- `bastao` não reconhecido (terminal aberto antes do install)? Não investigue: use `node $env:USERPROFILE\.agents\bastao\bastao.mjs <comando>` ou reinicie o terminal.
- Comece sempre por `bastao status`. Ciclo ativo → `pass`, nunca `init` (outro `init` com outro slug cria um ciclo novo). Opções de todos os comandos: `bastao --help`.
- No Antigravity: configure a execução automática para comandos de terminal (`bastao`, `git`, `node`, testes).
