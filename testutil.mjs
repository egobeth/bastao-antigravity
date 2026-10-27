import { after } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const BASTAO_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bastao.mjs');
export const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bastao-teste-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }));

// Nenhum teste toca o índice real nem abre notificação do Windows.
process.env.BASTAO_NOTIFY = 'off';
process.env.BASTAO_INDEX = path.join(ROOT, 'indice.json');
// Nenhum teste chama o agentapi real do Antigravity.
const agentapiNulo = path.join(ROOT, 'agentapi-nulo.mjs');
fs.writeFileSync(agentapiNulo, 'process.exit(0);\n');
process.env.BASTAO_AGENTAPI = agentapiNulo;

export function runCli(args, cwd, env = {}) {
  return spawnSync(process.execPath, [BASTAO_CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

export function git(cwd, ...args) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

export function tempRepo() {
  const base = path.join(ROOT, `bastao-teste-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const repoDir = path.join(base, 'pasta com espaço é');
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, 'init');
  // git worktree exige HEAD.
  git(repoDir, 'commit', '--allow-empty', '-m', 'init');
  return repoDir;
}
