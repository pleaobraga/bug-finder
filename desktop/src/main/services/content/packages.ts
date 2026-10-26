/** Builds stage package zips and the manifest (used by tools/build-stage-packages and tests). */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runChecked } from '../process.ts';
import type { CommandRunner } from '../process.ts';
import { sha256Hex, treeDigest, writeZip } from './archive.ts';
import { gitArchive, readPackageDir } from './local.ts';
import { parseManifest } from './manifest.ts';
import type { StageEntry, StageManifest } from './manifest.ts';

export interface BuildOptions {
  repo: string;
  out: string;
  version: string;
  runner: CommandRunner;
  git?: string;
  now?: string;
  log?: (line: string) => void;
}

export async function buildStagePackages(options: BuildOptions): Promise<StageManifest> {
  const { repo, out, version, runner, git = 'git' } = options;
  const gitText = async (...args: string[]) =>
    (await runChecked(runner, git, ['-c', 'safe.directory=*', '-C', repo, ...args])).stdout.toString('utf8').trim();

  const stagesDir = join(repo, 'qa', 'stages');
  const stageNumbers = (await readdir(stagesDir))
    .map((name) => /^stage-(\d+)$/.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const stages: StageEntry[] = [];
  for (const stage of stageNumbers) {
    const branch = `stage-${stage}`;
    const packageFiles = await readPackageDir(join(stagesDir, branch));
    const zip = writeZip(packageFiles);
    const file = `${branch}-v${version}.zip`;
    await writeFile(join(out, file), zip);

    const codeFiles = await gitArchive(runner, git, repo, branch);
    stages.push({
      stage,
      branch,
      commit: await gitText('rev-parse', `refs/heads/${branch}`),
      commitMessage: await gitText('log', '-1', '--format=%s', `refs/heads/${branch}`),
      codeDigest: treeDigest(codeFiles),
      codeFiles: codeFiles.length,
      package: { file, sha256: sha256Hex(zip), size: zip.length, digest: treeDigest(packageFiles) },
    });
    options.log?.(`${branch}: ${packageFiles.length} package files, ${codeFiles.length} code files -> ${file}`);
  }

  const manifest = parseManifest({
    format: 'bug-detective-stages',
    formatVersion: 1,
    version,
    createdAt: options.now ?? new Date().toISOString(),
    stages,
  });
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
