import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeZip } from '../../src/main/services/content/archive.ts';
import { DownloadError, GitHubContentSource, validateBaseUrl } from '../../src/main/services/content/github.ts';
import { LocalContentSource, gitArchive } from '../../src/main/services/content/local.ts';
import { ContentVerificationError } from '../../src/main/services/content/manifest.ts';
import type { StageManifest } from '../../src/main/services/content/manifest.ts';
import { buildStagePackages } from '../../src/main/services/content/packages.ts';
import { PackageStore } from '../../src/main/services/content/store.ts';
import { runChecked, runCommand } from '../../src/main/services/process.ts';

let root: string;
let repo: string;
let out: string;
let manifest: StageManifest;

async function git(...args: string[]) {
  return (await runChecked(runCommand, 'git', ['-C', repo, ...args])).stdout.toString('utf8').trim();
}

/** A tiny SupportDesk-like repository: main with qa/stages/stage-1, and an orphan stage-1 branch. */
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bd-content-'));
  repo = join(root, 'supportdesk');
  out = join(root, 'packages');
  await mkdir(join(repo, 'qa', 'stages', 'stage-1', 'gate2'), { recursive: true });
  await runChecked(runCommand, 'git', ['init', '-q', '-b', 'main', repo]);
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  // core.autocrlf=true must not leak CRLF into the archive.
  await git('config', 'core.autocrlf', 'true');
  await writeFile(join(repo, 'qa', 'stages', 'stage-1', 'ticket.en.md'), '# SD-214: Details\n');
  await writeFile(join(repo, 'qa', 'stages', 'stage-1', 'bug.patch'), 'authoring only\n');
  await writeFile(join(repo, 'qa', 'stages', 'stage-1', 'gate2', 'ticket-1.spec.ts'), 'test()\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'main');
  await git('checkout', '-q', '--orphan', 'stage-1');
  await git('rm', '-rq', '--cached', '.');
  await rm(join(repo, 'qa'), { recursive: true });
  await mkdir(join(repo, 'client'));
  await writeFile(join(repo, 'package.json'), '{\n  "name": "supportdesk"\n}\n');
  await writeFile(join(repo, 'client', 'App.tsx'), 'export {};\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'SupportDesk release 1.1');
  await git('checkout', '-q', '-f', 'main');
  manifest = await buildStagePackages({ repo, out, version: '1.0.0', runner: runCommand });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('build-stage-packages', () => {
  it('writes a versioned zip per stage and a manifest with checksums', async () => {
    expect(manifest.stages).toHaveLength(1);
    const [entry] = manifest.stages;
    expect(entry).toMatchObject({ stage: 1, branch: 'stage-1', commitMessage: 'SupportDesk release 1.1', codeFiles: 2 });
    expect(entry.package.file).toBe('stage-1-v1.0.0.zip');
    expect(JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'))).toEqual(manifest);
  });

  it('keeps LF line endings regardless of core.autocrlf', async () => {
    const files = await gitArchive(runCommand, 'git', repo, 'stage-1');
    for (const file of files) {
      expect(Buffer.from(file.data).includes(13), file.path).toBe(false);
    }
  });
});

describe('LocalContentSource', () => {
  const source = () => new LocalContentSource({ repoPath: repo, manifestPath: join(out, 'manifest.json'), runner: runCommand });

  it('reads the stage branch and the package, verified against the manifest', async () => {
    const stage = await source().fetchStage(1);
    expect(stage.codeFiles.map((file) => file.path).sort()).toEqual(['client/App.tsx', 'package.json']);
    expect(stage.packageFiles.map((file) => file.path).sort()).toEqual(['gate2/ticket-1.spec.ts', 'ticket.en.md']);
  });

  it('never includes bug.patch in the package', async () => {
    const stage = await source().fetchStage(1);
    expect(stage.packageFiles.some((file) => file.path === 'bug.patch')).toBe(false);
  });

  it('rejects a package folder that changed after the manifest was built', async () => {
    const file = join(repo, 'qa', 'stages', 'stage-1', 'ticket.en.md');
    const original = await readFile(file);
    await writeFile(file, '# SD-214: Changed\n');
    try {
      await expect(source().fetchStage(1)).rejects.toThrow(ContentVerificationError);
    } finally {
      await writeFile(file, original);
    }
  });

  it('rejects an unknown stage', async () => {
    await expect(source().fetchStage(2)).rejects.toThrow(/not in the manifest/);
  });
});

describe('GitHubContentSource (mock server)', () => {
  let server: Server;
  let baseUrl: string;
  const requests: string[] = [];
  let failNext = 0;
  let tamperCode = false;

  beforeAll(async () => {
    const zip = await readFile(join(out, 'stage-1-v1.0.0.zip'));
    const manifestJson = await readFile(join(out, 'manifest.json'));
    const stageFiles = await gitArchive(runCommand, 'git', repo, 'stage-1');
    const codeZip = () =>
      writeZip(
        (tamperCode ? [...stageFiles.slice(0, 1)] : stageFiles).map((file) => ({ ...file, path: `supportdesk-stage-1/${file.path}` })),
      );
    server = createServer((request, response) => {
      requests.push(request.url!);
      if (failNext > 0) {
        failNext -= 1;
        response.writeHead(503).end();
        return;
      }
      switch (request.url) {
        case '/owner/supportdesk/releases/latest/download/manifest.json':
          response.writeHead(200, { 'content-type': 'application/json' }).end(manifestJson);
          return;
        case '/owner/supportdesk/releases/latest/download/stage-1-v1.0.0.zip':
          // GitHub redirects release assets to another host.
          response.writeHead(302, { location: '/objects/stage-1-v1.0.0.zip' }).end();
          return;
        case '/objects/stage-1-v1.0.0.zip':
          response.writeHead(200).end(zip);
          return;
        case '/owner/supportdesk/archive/refs/heads/stage-1.zip':
          response.writeHead(302, { location: '/codeload/stage-1.zip' }).end();
          return;
        case '/codeload/stage-1.zip':
          response.writeHead(200).end(codeZip());
          return;
        case '/owner/tampered/releases/latest/download/manifest.json':
          response.writeHead(200).end(manifestJson);
          return;
        case '/owner/tampered/releases/latest/download/stage-1-v1.0.0.zip':
          response.writeHead(200).end(Buffer.concat([zip, Buffer.from('x')]));
          return;
        default:
          response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const source = (repository = 'owner/supportdesk') => new GitHubContentSource({ repository, baseUrl, retries: 2 });

  it('downloads the branch archive and the release asset, following redirects', async () => {
    requests.length = 0;
    const stage = await source().fetchStage(1);
    expect(stage.codeFiles.map((file) => file.path).sort()).toEqual(['client/App.tsx', 'package.json']);
    expect(requests).toEqual([
      '/owner/supportdesk/releases/latest/download/manifest.json',
      '/owner/supportdesk/releases/latest/download/stage-1-v1.0.0.zip',
      '/objects/stage-1-v1.0.0.zip',
      '/owner/supportdesk/archive/refs/heads/stage-1.zip',
      '/codeload/stage-1.zip',
    ]);
  });

  it('only downloads the requested stage', async () => {
    requests.length = 0;
    await source().fetchStage(1);
    expect(requests.some((url) => /stage-[2-9]/.test(url))).toBe(false);
  });

  it('retries server errors', async () => {
    failNext = 2;
    await expect(source().fetchStage(1)).resolves.toBeDefined();
  });

  it('gives up after the retries', async () => {
    failNext = 10;
    await expect(source().fetchStage(1)).rejects.toThrow(DownloadError);
    failNext = 0;
  });

  it('rejects a release asset that does not match its checksum', async () => {
    await expect(source('owner/tampered').fetchStage(1)).rejects.toThrow(ContentVerificationError);
  });

  it('rejects a branch archive that does not match the manifest', async () => {
    tamperCode = true;
    try {
      await expect(source().fetchStage(1)).rejects.toThrow(/stage code/);
    } finally {
      tamperCode = false;
    }
  });

  it('reports a missing release', async () => {
    await expect(source('owner/missing').fetchStage(1)).rejects.toThrow(/HTTP 404/);
  });

  it('accepts only https, or http on loopback', () => {
    expect(() => validateBaseUrl('http://example.com')).toThrow();
    expect(() => validateBaseUrl('https://user:pw@github.com')).toThrow();
    expect(validateBaseUrl('https://github.com').hostname).toBe('github.com');
    expect(() => new GitHubContentSource({ repository: '../etc' })).toThrow();
    expect(() => new GitHubContentSource({ repository: 'a/b', release: 'v1/../../x' })).toThrow();
  });

  it('enforces a size limit', async () => {
    const small = new GitHubContentSource({ repository: 'owner/supportdesk', baseUrl, maxBytes: 100, retries: 0 });
    await expect(small.fetchStage(1)).rejects.toThrow(/larger than/);
  });
});

describe('PackageStore', () => {
  it('stores the zip and an extracted folder, replacing an older copy atomically', async () => {
    const store = new PackageStore(join(root, 'João Silva', 'packages'));
    const zip = await readFile(join(out, 'stage-1-v1.0.0.zip'));
    expect(store.has(1)).toBe(false);
    await store.save(1, zip);
    await store.save(1, zip);
    expect(store.has(1)).toBe(true);
    expect(await store.readText(1, 'ticket.en.md')).toBe('# SD-214: Details\n');
    expect(await store.readText(1, 'missing.md')).toBeNull();
    expect(Buffer.compare(await store.readZip(1), zip)).toBe(0);
  });
});
