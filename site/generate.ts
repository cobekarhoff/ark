import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transitions } from '../cli/transitions';

const repository = fileURLToPath(new URL('../', import.meta.url));
const playbook = readFileSync(new URL('../skills/ark/playbooks/ticket.md', import.meta.url), 'utf8');
const steps = [...playbook.matchAll(/^(\d+)\. (.+)$/gm)].map((match) => {
  const [title, ...description] = match[2].split(': ');
  return { number: Number(match[1]), title, description: description.join(': '), label: match[2] };
});
if (steps.length !== 10 || steps.some((step, index) => step.number !== index + 1 || !step.description)) {
  throw new Error('Expected the ten ordered ticket playbook steps; update the documentation generator for a changed playbook structure.');
}
for (const events of Object.values(transitions)) {
  for (const destination of Object.values(events)) {
    if (!(destination in transitions)) throw new Error(`Unknown lifecycle destination: ${destination}`);
  }
}
const help = Bun.spawnSync([process.execPath, 'cli/ark.ts', '--help'], { cwd: repository });
if (help.exitCode !== 0) throw new Error(`CLI help generation failed: ${help.stderr.toString()}`);
const directory = new URL('./.generated/', import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL('cli-help.txt', directory), help.stdout);
writeFileSync(new URL('flow.json', directory), JSON.stringify({ transitions, steps }, null, 2) + '\n');
