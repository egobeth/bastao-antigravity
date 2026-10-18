# bastão (antigravity)

[English](README.md) · **Português**

Revezamento automático entre **Claude Code**, **Gemini** e **Codex** dentro do **Antigravity IDE**. Você aprova a spec e o plano uma vez; a partir daí os agentes passam o "bastão" entre si sozinhos: implementar, revisar, corrigir, revisar de novo, até o trabalho ser aprovado ou eles precisarem de você. Nada de copiar e colar entre chats, nada de dar prompt em cada agente na mão.

Você continua no controle: acompanhe a conversa de qualquer agente em tempo real, entre quando quiser, pause o ciclo, troque quem faz o quê ou responda a uma dúvida levantada por um agente.

Um único arquivo, zero dependências, só Node.js. Funciona com as assinaturas que você já tem; sem chave de API.

## O que roda sozinho e onde você entra

| Automático | Só se você quiser (ou for chamado) |
|---|---|
| Passar a vez para o próximo agente | Aprovar spec e plano antes de o ciclo começar (o único portão fixo) |
| Acordar o agente da vez | Escrever no chat de qualquer agente no meio do ciclo |
| Loops implementar → revisar → corrigir, até `--max-rounds` | `bastao pause` para assumir, `bastao pass --from=human …` para devolver |
| Evidência de cada turno em `docs/evidence/` | Responder quando um agente roda `bastao ask` (você recebe um popup) |
| Parar quando aprovado ou sem rodadas (popup) | Trocar papéis ou skills: `--roles=implement:codex,review:claude+gemini` |

Os agentes trabalham numa branch `ai/<slug>` e nunca fazem merge, push ou deploy sem você.

## Como um ciclo funciona

1. Você e o Claude escrevem a spec e o plano. Você aprova; o Claude roda `bastao init` e passa para o implementador.
2. Cada agente, ao terminar o turno, roda `bastao pass` e vai dormir.
3. O próximo agente acorda sozinho:
   - **Gemini**: um `bastao wait` em segundo plano manda uma mensagem para a conversa dele no Antigravity (via `agentapi` do Antigravity), que retoma o trabalho.
   - **Claude Code**: um `bastao wait` em segundo plano termina e o Claude Code retoma a sessão.
   - **Codex**: `bastao pass --to=codex` dispara o `codex exec` direto (veja abaixo).
4. O revisor devolve correções (`fix`, próxima rodada) ou aprova (`done`). Tudo que precisa de você gera um popup.

O estado fica em `.agents/turn.json` na raiz do repositório, fora do git automaticamente. As regras dos agentes estão no [SKILL.md](SKILL.md).

## Codex: roda em segundo plano, não no chat aberto

O painel do Codex no Antigravity **não** se atualiza com turnos feitos fora dele; é uma limitação da extensão do Codex, não algo que o bastão consiga resolver. Por isso o Codex funciona assim:

- Os turnos rodam sem interface com `codex exec` (sandbox `workspace-write` no seu repositório), retomando a mesma thread do Codex a cada rodada, então ele mantém a memória do ciclo. Passe `--codex-thread=<id>` no `init` para continuar uma thread que você já tem aberta.
- Tudo que ele imprime é gravado ao vivo em **`.agents/live/codex.log`**, com um cabeçalho `=== Round r/m · ação · HH:MM ===` por turno. Acompanhe com:
  ```powershell
  Get-Content .agents\live\codex.log -Wait
  ```
- Para ver esses turnos no próprio painel do Codex, rode **Developer: Reload Window** no Antigravity.
- Se o Codex terminar sem passar o bastão (falha, binário ausente ou simplesmente parou), o ciclo vai para "aguardando humano" com popup, em vez de travar. Responda com:
  `bastao pass --from=human --to=codex --action=<ação> --force --notes="<sua resposta>"`

## Requisitos

- Windows, Node.js 18+, git.
- Antigravity IDE com as extensões do Claude Code e do Codex (OpenAI), logadas.
- **Ative a execução automática de comandos de terminal no Antigravity** (`bastao`, `git`, `node`, seus testes). Senão o Gemini para pedindo aprovação a cada comando e o revezamento trava.
- Mantenha as conversas dos agentes abertas no Antigravity; uma sessão do Claude Code fechada não pode ser retomada pelo vigia. O despertar do Gemini só funciona quando iniciado num terminal de agente do Antigravity.

> Feito primeiro para Windows: os popups usam `msg`, o Gemini é acordado com `agentapi.bat` e o Codex é localizado com `where`. A máquina de estados é portável; PRs para outras plataformas são bem-vindos.

## Instalação

```powershell
git clone https://github.com/egobeth/bastao-antigravity "$env:USERPROFILE\.agents\bastao"
node "$env:USERPROFILE\.agents\bastao\bastao.mjs" install        # simulação: mostra o que mudaria
node "$env:USERPROFILE\.agents\bastao\bastao.mjs" install --yes  # aplica
```

Depois **reinicie o terminal** para o `bastao` entrar no PATH (funciona no PowerShell, no cmd e no Git Bash). Até lá, chame `node ...\bastao.mjs` direto.

O `install --yes` altera a sua máquina:
- copia o `SKILL.md` para `~/.claude/skills/bastao`, `~/.gemini/config/skills/bastao` e `~/.codex/skills/bastao`;
- adiciona `Bash(bastao:*)` e `PowerShell(bastao:*)` à lista de permissões em `~/.claude/settings.json`;
- acrescenta a pasta da ferramenta ao `PATH` do usuário.

Os projetos não precisam de configuração própria: com spec e plano aprovados, peça a qualquer agente para "iniciar o bastão".

## Uso

```powershell
bastao status                                   # comece sempre por aqui
bastao init --task="Exportar CSV" --spec=docs/spec.md --plan=docs/plan.md --implement=gemini --review=claude,codex
bastao pass --from=claude --to=gemini --action=implement --notes="Plano aprovado"
bastao wait --for=claude                        # bloqueia até ser a vez do Claude
bastao ask  --from=gemini --question="Manter o endpoint antigo?"
bastao pause                                    # o humano assume
bastao pass --from=human --to=gemini --action=implement --force --notes="Mantenha"
bastao --help                                   # todas as opções
```

Ciclo já existe? Use `status` e `pass`, nunca `init`. Todos os comandos aceitam `--repo=<dir>`. Use `BASTAO_NOTIFY=off` para silenciar os popups e `BASTAO_CODEX` / `BASTAO_AGENTAPI` para apontar outros caminhos dos binários.

Códigos de saída do `wait`: `0` sua vez · `2` tempo esgotado, rearme · `3` ciclo aprovado/pausado/sem rodadas · `4` já existe um vigia ativo · `5` falha ao acordar o Gemini.

## Testes

```powershell
node --test test.mjs
```

## Licença

[MIT](LICENSE) © Eduardo Gobeth
