/**
 * Assembles the Docker build contexts in build/docker/ (packaged as app resources):
 *   workspace/  the player's workspace image (docker/workspace/)
 *   qa/         the QA image (docker/qa/) with a copy of the SupportDesk QA CLI, without stages/
 * and writes build/docker/images.json with content-addressed image tags.
 *
 *   node tools/prepare-resources.ts [--repo ../supportdesk]
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { sha256Hex } from '../src/main/services/content/archive.ts';

const root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: { repo: { type: 'string', default: resolve(root, '..', 'supportdesk') } } });
const qaSource = join(resolve(values.repo!), 'qa');
const out = join(root, 'build', 'docker');
const QA_EXCLUDED = new Set(['node_modules', 'stages', 'test-results', 'playwright-report', '.gitignore']);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(root, 'docker', 'workspace'), join(out, 'workspace'), { recursive: true });
await cp(join(root, 'docker', 'qa'), join(out, 'qa'), { recursive: true });
await cp(qaSource, join(out, 'qa', 'cli'), {
  recursive: true,
  filter: (source) => {
    const name = basename(source);
    return relative(qaSource, source) === '' || (!QA_EXCLUDED.has(name) && !name.startsWith('.package-'));
  },
});

/** Hash of every file in a build context, so a changed Dockerfile or CLI gets a new image tag. */
async function contextHash(dir: string): Promise<string> {
  const entries = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const lines: string[] = [];
  for (const file of entries) {
    lines.push(`${sha256Hex(await readFile(file))}  ${relative(dir, file).split(sep).join('/')}`);
  }
  return sha256Hex(lines.join('\n')).slice(0, 12);
}

const images = {
  workspace: `bugdetective-workspace:${await contextHash(join(out, 'workspace'))}`,
  qa: `bugdetective-qa:${await contextHash(join(out, 'qa'))}`,
  nodeVersion: (await readFile(join(root, '.nvmrc'), 'utf8')).trim(),
};
await writeFile(join(out, 'images.json'), `${JSON.stringify(images, null, 2)}\n`);
console.log(`Docker contexts written to ${out}`);
console.log(images);
