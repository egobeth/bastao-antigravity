---
name: bastao
description: Use quando o usuário pedir para entrar no bastão, retome o bastão, status do bastão, passar o bastão ou coordenar o handoff multi-agente entre Claude, Gemini e Codex.
---

# Protocolo do Bastão

Protocolo de passagem de turno e handoff conversacional contínuo entre Claude Code, Gemini (Antigravity) e Codex.

## 1. Princípios Gerais

- **Fonte da verdade:** `.agents/turn.json` na raiz do repositório git.
- **Divisão padrão de papéis:**
  - Claude: especificação, planejamento e revisão.
  - Gemini: implementação (maior cota de contexto).
  - Codex: implementação ou revisão complementar via `exec resume`.
- **Branch de trabalho:** todo trabalho de IA acontece na branch `ai/<slug>`. Nunca altere nem faça commits diretamente na `main` ou `master`.
- **Proibições sem autorização explícita do usuário:** merge, push, deploy, apagar branches e alterar arquivos fora do repositório.

## 2. Regras por Agente

### Claude Code
- Ao esperar sua vez: execute `bastao wait --for=claude` com `run_in_background`. Quando o comando terminar, sua sessão será reativada automaticamente.

### Gemini (Antigravity)
- Obtenha o seu Conversation ID nos metadados da sessão.
- Ao esperar sua vez: execute `bastao wait --for=gemini --wake=<id>` em segundo plano e encerre seu turno. O vigia acordará esta conversa quando chegar sua vez.
- Nunca use vigia sem passar o seu ID atualizado. Numa conversa nova ("retome o bastão"), o `wait` com o novo ID substitui o antigo.

### Codex
- **Nunca arma vigia.** O Codex é acionado diretamente pelo comando `bastao pass --to=codex` e encerra sua execução assim que passar o bastão.
- A saída do Codex fica em `.agents/live/codex.log`, com um separador `=== Round r/m · <ação> · HH:MM ===` por turno.
- Se o Codex terminar sem passar o bastão, o ciclo vai para `WAITING_HUMAN` com a pergunta automática. Para responder, qualquer IA no chat roda, a pedido do usuário:
  `bastao pass --from=human --to=codex --action=<ação> --force --notes="<resposta do usuário>"`

### Saídas do `wait`
| Código | O que fazer |
|---|---|
| 0 | é sua vez: siga as instruções impressas |
| 2 | tempo esgotado: arme o `wait` de novo |
| 3 | ciclo `APPROVED`, `MAX_ROUNDS_REACHED` ou `MANUAL_PAUSE`: rode `bastao status` e avise o usuário; não rearme |
| 4 | já existe vigia vivo para você: não arme outro |
| 5 | falha ao acordar o Gemini: avise o usuário |

## 3. Fluxo de Trabalho

### Iniciar um ciclo (Claude, depois que o usuário aprovar spec e plano)
`bastao init --task="<tarefa>" --slug=<slug> --spec=<caminho> --plan=<caminho> [--implement=gemini] [--review=claude,codex] [--max-rounds=3] [--codex-thread=<id>]`

Depois, `bastao pass --from=claude --to=<implementador> --action=implement --notes="<resumo>"`. Papéis e skills mudam a qualquer momento com `--roles=implement:codex,review:claude+gemini` e `--skills=a,b` no `pass`. O usuário assume o controle com `bastao pause` e devolve com `bastao pass --from=human --to=<agente> --action=<ação>`.

### Ao entrar ou retomar
1. Execute `bastao status` para ler o estado atual do ciclo.
2. Se for a sua vez (`Vez de: <seu-nome>`), realize o trabalho correspondente.
3. Se não for sua vez, arme o vigia conforme as regras do seu agente e encerre o turno.

### Turno de Implementação (`implement`)
1. Leia a spec (`Spec:`), o plano (`Plano:`), as notas (`Notas:`) e as skills ativas. Na rodada 2+, leia também a evidência de revisão anterior (`docs/evidence/<data>-<slug>-review-<N-1>.md`).
2. Garanta que está na branch `ai/<slug>`.
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
1. Analise o trabalho com base na spec, plano, evidência de implementação e diff da branch. Execute testes se necessário.
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

## 4. Pré-requisitos e Execução Automática
- No Antigravity: configure a execução automática para comandos de terminal (`bastao`, `git`, `node`, testes).
