/**
 * Development source: stage code from the `stage-N` branches of a local SupportDesk checkout
 * (git archive) and packages from its qa/stages/stage-N/ folders, verified against the manifest
 * written by tools/build-stage-packages.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { runChecked } from '../process.ts';
import type { CommandRunner } from '../process.ts';
import { readTar, readZip, writeZip } from './archive.ts';
import type { ArchiveFile } from './archive.ts';
import { PACKAGE_EXCLUDED, parseManifest, stageEntry } from './manifest.ts';
import type { StageManifest } from './manifest.ts';
import { verifyStage } from './source.ts';
import type { ContentSource, FetchedStage } from './source.ts';

export interface LocalSourceOptions {
  /** The SupportDesk repository (with the stage-N branches and qa/stages/). */
  repoPath: string;
  /** manifest.json written by tools/build-stage-packages. */
  manifestPath: string;
  runner: CommandRunner;
  git?: string;
}

/** `git archive` of a ref, with line-ending conversion disabled so files keep LF on Windows. */
export async function gitArchive(runner: CommandRunner, git: string, repoPath: string, ref: string): Promise<ArchiveFile[]> {
  const { stdout } = await runChecked(
    runner,
    git,
    ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'safe.directory=*', '-C', repoPath, 'archive', '--format=tar', ref],
    { timeoutMs: 120_000 },
  );
  return readTar(stdout);
}

/**
 * Text files are normalized to LF: a Windows checkout with core.autocrlf=true has CRLF in its
 * working tree, and the package must be byte-identical on every platform (and git apply needs LF).
 */
function normalizeLineEndings(data: Buffer): Buffer {
  return data.includes(0) || !data.includes(13) ? data : Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'));
}

/** Reads a stage package folder as archive files (without authoring-only files). */
export async function readPackageDir(dir: string): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const full = join(entry.parentPath, entry.name);
    const path = relative(dir, full).split(sep).join('/');
    if (!PACKAGE_EXCLUDED.has(path)) {
      files.push({ path, data: new Uint8Array(normalizeLineEndings(await readFile(full))), executable: false });
    }
  }
  return files;
}

export class LocalContentSource implements ContentSource {
  readonly kind = 'local';
  private readonly options: LocalSourceOptions;

  constructor(options: LocalSourceOptions) {
    this.options = options;
  }

  describe(): string {
    return this.options.repoPath;
  }

  async manifest(): Promise<StageManifest> {
    return parseManifest(JSON.parse(await readFile(this.options.manifestPath, 'utf8')));
  }

  async fetchStage(stage: number): Promise<FetchedStage> {
    const { repoPath, runner, git = 'git' } = this.options;
    const entry = stageEntry(await this.manifest(), stage);
    const packageFiles = await readPackageDir(join(repoPath, 'qa', 'stages', `stage-${stage}`));
    const packageZip = writeZip(packageFiles);
    const codeFiles = await gitArchive(runner, git, repoPath, entry.branch);
    return verifyStage({ entry, packageZip, packageFiles: readZip(packageZip), codeFiles });
  }
}
