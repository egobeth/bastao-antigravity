# bastão (antigravity)

**English** · [Português](README.pt-BR.md)

Hands-off relay between **Claude Code**, **Gemini** and **Codex** inside the **Antigravity IDE**. You approve a spec and a plan once; from there the agents pass the "baton" to each other on their own: implement, review, fix, review again, until the work is approved or they need you. No copy-pasting between chats, no prompting each agent by hand.

You stay in control: watch any agent's conversation as it happens, jump in at any moment, pause the cycle, change who does what, or answer a question an agent raised.

Single file, zero dependencies, Node.js only. Works with your existing subscriptions; no API keys.

## What runs on its own, and where you come in

| Automatic | Only if you want (or are asked) |
|---|---|
| Handing the turn to the next agent | Approving spec and plan before the cycle starts (the one built-in gate) |
| Waking the agent whose turn it is | Typing in any agent's chat mid-cycle |
| Implement → review → fix loops, up to `--max-rounds` | `bastao pause` to take over, `bastao pass --from=human …` to hand back |
| Evidence of each turn in `docs/evidence/` | Answering when an agent runs `bastao ask` (you get a popup) |
| Stopping when approved or out of rounds (popup) | Switching roles or skills: `--roles=implement:codex,review:claude+gemini` |

Agents work on an `ai/<slug>` branch and never merge, push or deploy without you.

## How a cycle runs

1. You and Claude write the spec and plan. You approve them; Claude runs `bastao init` and passes to the implementer.
2. Each agent, when its turn ends, runs `bastao pass` and goes to sleep.
3. The next agent wakes up by itself:
   - **Gemini**: a background `bastao wait` sends a message to its Antigravity conversation (via Antigravity's `agentapi`), which resumes it.
   - **Claude Code**: a background `bastao wait` finishes and Claude Code resumes the session.
   - **Codex**: `bastao pass --to=codex` launches `codex exec` directly (see below).
4. The reviewer either sends fixes back (`fix`, next round) or approves (`done`). Anything that needs you raises a popup.

State lives in `.agents/turn.json` at the repo root, kept out of git automatically. The agent rules are in [SKILL.md](SKILL.md).

## Codex: runs in the background, not in your open chat

The Codex panel in Antigravity does **not** refresh with turns made from outside it; that's a limitation of the Codex extension, not something bastão can fix. So Codex works like this:

- Its turns run headless with `codex exec` (sandbox `workspace-write` in your repo), resuming the same Codex thread each round, so it keeps its memory of the cycle. Pass `--codex-thread=<id>` to `init` to continue a thread you already have open.
- Everything it prints is appended live to **`.agents/live/codex.log`**, with a `=== Round r/m · action · HH:MM ===` header per turn. Follow it with:
  ```powershell
  Get-Content .agents\live\codex.log -Wait
  ```
- To see those turns in the Codex panel itself, run **Developer: Reload Window** in Antigravity.
- If Codex exits without passing the baton (crash, missing binary, it simply stopped), the cycle switches to "waiting for human" with a popup instead of hanging. Answer with:
  `bastao pass --from=human --to=codex --action=<action> --force --notes="<your answer>"`

## Requirements

- Windows, Node.js 18+, git.
- Antigravity IDE with the Claude Code and Codex (OpenAI) extensions, logged in.
- **Turn on auto-run for terminal commands in Antigravity** (`bastao`, `git`, `node`, your tests). Otherwise Gemini stops for approval at every command and the relay stalls.
- Keep the agents' conversations open in Antigravity; a closed Claude Code session can't be resumed by its watcher. Gemini's wake-up works only when started from an Antigravity agent terminal.

> Windows-first: popups use `msg`, Gemini is woken with `agentapi.bat`, Codex is found with `where`. The state machine is portable; PRs for other platforms welcome.

## Install

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

Projects need no setup of their own: once spec and plan are approved, ask any agent to "start the bastão".

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

All commands accept `--repo=<dir>`. Set `BASTAO_NOTIFY=off` to silence popups, `BASTAO_CODEX` / `BASTAO_AGENTAPI` to override binary paths.

`wait` exit codes: `0` your turn · `2` timeout, re-arm · `3` cycle approved/paused/out of rounds · `4` a watcher is already running · `5` failed to wake Gemini.

## Tests

```powershell
node --test test.mjs
```

## License

[MIT](LICENSE) © Eduardo Gobeth
