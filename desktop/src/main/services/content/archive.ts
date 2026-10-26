/**
 * Archive helpers shared by the content sources, the stage package tool and backups:
 * tar and zip reading/writing, path safety and SHA-256 tree digests.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import { extract, pack } from 'tar-stream';

export interface ArchiveFile {
  /** POSIX relative path, validated by safeRelativePath. */
  path: string;
  data: Uint8Array;
  executable: boolean;
}

export class UnsafeArchiveError extends Error {}

/** Validates an archive entry path: relative, no `..`, no drive letters or backslashes. */
export function safeRelativePath(raw: string): string {
  const path = raw.replace(/^\.\//, '');
  const segments = path.split('/');
  const unsafe =
    path === '' ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    /^[A-Za-z]:/.test(path) ||
    segments.some((segment) => segment === '..' || segment === '.' || segment === '');
  if (unsafe) {
    throw new UnsafeArchiveError(`Unsafe path in archive: ${JSON.stringify(raw)}`);
  }
  return path;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Digest of a set of files that does not depend on the archive format: SHA-256 over the sorted
 * lines "<sha256 of content>  <path>". The same tree gives the same digest from git archive,
 * a GitHub zip or an extracted folder.
 */
export function treeDigest(files: readonly ArchiveFile[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${sha256Hex(file.data)}  ${file.path}\n`)
    .join('');
  return `sha256:${sha256Hex(lines)}`;
}

/** Reads the regular files of a tar archive (for example `git archive --format=tar`). */
export async function readTar(input: Uint8Array | Readable): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = [];
  const extractor = extract();
  const done = new Promise<void>((resolve, reject) => {
    extractor.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: unknown) => chunks.push(chunk as Buffer));
      stream.on('end', () => {
        if (header.type === 'file') {
          files.push({
            path: safeRelativePath(header.name),
            data: new Uint8Array(Buffer.concat(chunks)),
            executable: ((header.mode ?? 0o644) & 0o111) !== 0,
          });
        }
        next();
      });
      stream.on('error', reject);
      stream.resume();
    });
    extractor.on('finish', resolve);
    extractor.on('error', reject);
  });
  const source = input instanceof Uint8Array ? Readable.from([Buffer.from(input)]) : input;
  source.on('error', (error) => extractor.destroy(error));
  source.pipe(extractor);
  await done;
  return files;
}

/** Writes files as a tar archive (used to stream a snapshot into the workspace container). */
export async function writeTar(files: readonly ArchiveFile[]): Promise<Buffer> {
  const packer = pack();
  const chunks: Buffer[] = [];
  packer.on('data', (chunk: unknown) => chunks.push(chunk as Buffer));
  const finished = new Promise<void>((resolve, reject) => {
    packer.on('end', resolve);
    packer.on('error', reject);
  });
  for (const file of files) {
    await new Promise<void>((resolve, reject) =>
      packer.entry(
        { name: file.path, mode: file.executable ? 0o755 : 0o644, mtime: new Date(0), size: file.data.length },
        Buffer.from(file.data),
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  }
  packer.finalize();
  await finished;
  return Buffer.concat(chunks);
}

/**
 * Reads a zip archive. With `stripTopDirectory`, the single top-level folder that GitHub puts in
 * branch archives (`repo-branch/`) is removed from every path.
 */
export function readZip(bytes: Uint8Array, options: { stripTopDirectory?: boolean } = {}): ArchiveFile[] {
  const entries = Object.entries(unzipSync(bytes)).filter(([name]) => !name.endsWith('/'));
  let prefix = '';
  if (options.stripTopDirectory) {
    const tops = new Set(entries.map(([name]) => name.split('/')[0]));
    if (tops.size !== 1 || entries.some(([name]) => !name.includes('/'))) {
      throw new UnsafeArchiveError('Expected a single top-level folder in the archive');
    }
    prefix = `${[...tops][0]}/`;
  }
  return entries.map(([name, data]) => ({
    path: safeRelativePath(name.slice(prefix.length)),
    data,
    executable: false,
  }));
}

/** Writes a deterministic zip: sorted entries and a fixed timestamp, so the checksum is stable. */
export function writeZip(files: readonly ArchiveFile[]): Uint8Array {
  const tree: Zippable = {};
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    tree[safeRelativePath(file.path)] = [file.data, { mtime: new Date('2000-01-01T00:00:00Z'), level: 9 }];
  }
  return zipSync(tree);
}

export function textFile(path: string, text: string): ArchiveFile {
  return { path, data: strToU8(text), executable: false };
}

export function fileText(file: ArchiveFile): string {
  return strFromU8(file.data);
}
