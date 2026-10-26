/**
 * Builds one versioned zip per stage from supportdesk/qa/stages/stage-N/ (without bug.patch)
 * plus manifest.json with SHA-256 checksums of every package and of every stage branch's files.
 * Upload the output as the assets of a GitHub Release (see README.md, "Publishing stages").
 *
 *   node tools/build-stage-packages.ts [--repo ../supportdesk] [--out build/stage-packages] [--version 1.0.0]
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildStagePackages } from '../src/main/services/content/packages.ts';
import { runCommand } from '../src/main/services/process.ts';

const root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: resolve(root, '..', 'supportdesk') },
    out: { type: 'string', default: resolve(root, 'build', 'stage-packages') },
    version: { type: 'string', default: '1.0.0' },
  },
});
const out = resolve(values.out!);
await buildStagePackages({ repo: resolve(values.repo!), out, version: values.version!, runner: runCommand, log: console.log });
console.log(`manifest.json written to ${out}`);
