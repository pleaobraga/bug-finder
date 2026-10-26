/**
 * Downloaded stage packages, kept in the app data folder (outside the Docker volume, so the
 * player's VS Code never sees the hidden tests or the reference fix).
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readZip } from './archive.ts';

export async function writeFileAtomic(file: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, data);
  await renameWithRetry(temp, file);
}

/** rename() can fail on Windows while an antivirus or indexer briefly holds the target. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 8 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

export class PackageStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  zipPath(stage: number): string {
    return join(this.root, `stage-${stage}.zip`);
  }

  /** The extracted package folder, mounted read-only into QA containers. */
  dir(stage: number): string {
    return join(this.root, `stage-${stage}`);
  }

  has(stage: number): boolean {
    return existsSync(this.zipPath(stage)) && existsSync(join(this.dir(stage), '.complete'));
  }

  /** Stores a verified package: the zip and an extracted folder, both replaced atomically. */
  async save(stage: number, zip: Uint8Array): Promise<void> {
    const files = readZip(zip);
    const staging = join(this.root, `.staging-${stage}-${randomUUID()}`);
    try {
      for (const file of files) {
        const target = join(staging, ...file.path.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.data);
      }
      await writeFile(join(staging, '.complete'), '');
      await writeFileAtomic(this.zipPath(stage), zip);
      await rm(this.dir(stage), { recursive: true, force: true });
      await renameWithRetry(staging, this.dir(stage));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  readZip(stage: number): Promise<Buffer> {
    return readFile(this.zipPath(stage));
  }

  /** Reads a text file of a stored package, or null when it does not exist. */
  async readText(stage: number, file: string): Promise<string | null> {
    try {
      return await readFile(join(this.dir(stage), ...file.split('/')), 'utf8');
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
