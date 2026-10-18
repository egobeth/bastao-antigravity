# bastão

Turn-passing ("baton") protocol for coding agents working on the same git repo: **Claude Code**, **Gemini (Antigravity)** and **Codex** take turns to spec, implement and review, one at a time, with a shared state file as the single source of truth.

Single file, zero dependencies, Node.js only.

> **Windows-first.** Notifications use `msg`, waking Gemini uses Antigravity's `agentapi.bat`, and Codex is located with `where`. The state machine itself is portable; the rest welcomes PRs.

## How it works

- State lives in `.agents/turn.json` at the repo root (kept out of git via `.git/info/exclude`).
- Default roles: Claude writes spec/plan and reviews, Gemini implements, Codex implements or reviews.
- A cycle goes `spec → implement → review → (fix → review)… → done`, up to `--max-rounds` (default 3).
- Agents waiting for their turn run `bastao wait` in the background; it exits (and wakes Gemini) when the turn arrives.
- Passing to Codex launches `codex exec` automatically; output goes to `.agents/live/codex.log`.
- Any agent can stop and ask the human (`bastao ask`); the human takes over with `bastao pause`.

The agent-side rules are in [SKILL.md](SKILL.md), which `install` copies to each agent's skills folder.

## Install

Requires Node.js 18+ and git.

```powershell
git clone https://github.com/egobeth/bastao-antigravity "$env:USERPROFILE\.agents\bastao"
node "$env:USERPROFILE\.agents\bastao\bastao.mjs" install        # dry run: shows what it would change
node "$env:USERPROFILE\.agents\bastao\bastao.mjs" install --yes  # apply
```

Then **restart your terminal** so `bastao` is on the PATH. Until then, call `node ...\bastao.mjs` directly.

`install --yes` changes your machine:
- copies `SKILL.md` to `~/.claude/skills/bastao`, `~/.gemini/antigravity/skills/bastao` and `~/.codex/skills/bastao`;
- adds `Bash(bastao:*)` and `PowerShell(bastao:*)` to the allow list in `~/.claude/settings.json`;
- appends the tool folder to your user `PATH`.

**Heads-up:** `bastao pass --to=codex` runs Codex unattended with `--sandbox workspace-write` in your repo.

## Usage

```powershell
bastao status                                   # always start here
bastao init --task="Add CSV export" --spec=docs/spec.md --plan=docs/plan.md --implement=gemini --review=claude,codex
bastao pass --from=claude --to=gemini --action=implement --notes="Plan approved"
bastao wait --for=claude                        # block until it's Claude's turn
bastao ask  --from=gemini --question="Keep the old endpoint?"
bastao pause                                    # human takes over
bastao pass --from=human --to=gemini --action=implement --force --notes="Keep it"
bastao --help                                   # all options
```

All commands accept `--repo=<dir>`. Set `BASTAO_NOTIFY=off` to silence notifications, `BASTAO_CODEX` / `BASTAO_AGENTAPI` to override binary paths.

`wait` exit codes: `0` your turn · `2` timeout, re-arm · `3` cycle approved/paused/out of rounds · `4` a watcher is already running · `5` failed to wake Gemini.

## Tests

```powershell
node --test test.mjs
```

---

## Em português

O bastão coordena Claude Code, Gemini (Antigravity) e Codex no mesmo repositório: um de cada vez, com `.agents/turn.json` como fonte da verdade. Por padrão o Claude especifica e revisa, o Gemini implementa e o Codex implementa ou revisa.

Instalação: clone em `%USERPROFILE%\.agents\bastao`, rode `node bastao.mjs install --yes` e **reinicie o terminal**. O `install` copia a skill para os três agentes, libera `bastao` no Claude Code e põe a pasta no PATH. Comece sempre por `bastao status`; com ciclo ativo use `pass`, nunca `init`. As regras de cada agente estão no [SKILL.md](SKILL.md).

## License

[MIT](LICENSE)
