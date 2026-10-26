/**
 * End-to-end flow with real Docker and LocalContentSource (run on Windows with Docker Desktop):
 *   unlock stage 1 → QA on the buggy stage (Gate 2 fails) → apply reference.patch inside the
 *   workspace container → QA again (both gates pass), plus timeout, export/restore and
 *   interrupted QA. Uses the "bugdetective-test" resource prefix, never the player's volumes.
 *
 *   npm run build && npm run test:integration
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Game } from '../../src/main/game.ts';
import { createWindowsPlatform } from '../../src/main/platform/windows.ts';
import { DockerRuntime } from '../../src/main/runtime.ts';
import { LocalContentSource } from '../../src/main/services/content/local.ts';
import { PackageStore } from '../../src/main/services/content/store.ts';
import { Docker } from '../../src/main/services/docker.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { StateStore } from '../../src/main/services/state.ts';
import { Workspace } from '../../src/main/services/workspace.ts';
import * as rules from '../../src/shared/kanban.ts';

const root = resolve(import.meta.dirname, '..', '..');
const supportdesk = resolve(root, '..', 'supportdesk');
const PREFIX = 'bugdetective-test';
const platform = createWindowsPlatform();

let dir: string;
let docker: Docker;
let runtime: DockerRuntime;

function createGame(stateDir = dir) {
  return new Game({
    store: new StateStore(stateDir),
    packages: new PackageStore(join(stateDir, 'packages')),
    content: new LocalContentSource({
      repoPath: supportdesk,
      manifestPath: join(root, 'build', 'stage-packages', 'manifest.json'),
      runner: runCommand,
    }),
    runtime,
    appVersion: '0.1.0-test',
    versions: { electron: 'none', node: process.versions.node, chrome: 'none' },
  });
}

async function workspace(): Promise<Workspace> {
  const tags = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string };
  return new Workspace({ docker, image: tags.workspace, isPortFree: platform.isPortFree, names: runtime.names });
}

/** Samples memory of the QA and workspace containers every 2 s while `run` is pending. */
async function measureDuring<T>(run: Promise<T>): Promise<{ result: T; peakQaMiB: number; peakWorkspaceMiB: number }> {
  let peakQaMiB = 0;
  let peakWorkspaceMiB = 0;
  let done = false;
  const sampler = (async () => {
    while (!done) {
      const stats = await docker.run(['stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}}']);
      for (const line of stats.stdout.toString('utf8').split('\n')) {
        const match = /^(\S+) ([\d.]+)(KiB|MiB|GiB)/.exec(line.trim());
        if (!match) continue;
        const mib = Number(match[2]) * ({ KiB: 1 / 1024, MiB: 1, GiB: 1024 } as const)[match[3] as 'MiB'];
        if (match[1].startsWith(`${PREFIX}-qa-`)) peakQaMiB = Math.max(peakQaMiB, mib);
        if (match[1] === runtime.names.container) peakWorkspaceMiB = Math.max(peakWorkspaceMiB, mib);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  })();
  try {
    const result = await run;
    return { result, peakQaMiB, peakWorkspaceMiB };
  } finally {
    done = true;
    await sampler;
  }
}

async function submit(game: Game, ticket: number) {
  await game.move(ticket, 'inQa');
  const started = Date.now();
  await game.waitForQa();
  return { ticket: rules.findTicket(game.current, ticket)!, seconds: (Date.now() - started) / 1000 };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'João Silva bd-integration-'));
  const { cli } = await platform.locateDocker();
  if (!cli) throw new Error('docker.exe not found');
  docker = new Docker(cli, runCommand);
  runtime = new DockerRuntime(platform, { contextRoot: join(root, 'build', 'docker'), prefix: PREFIX });
  // Start from a clean test namespace (never the player's "bugdetective-*" resources).
  const ws = await workspace();
  await ws.destroy();
});

afterAll(async () => {
  const ws = await workspace();
  await ws.destroy();
  await docker.removeVolume(runtime.names.vscodeVolume);
  await docker.removeVolume(runtime.names.cacheVolume);
  await rm(dir, { recursive: true, force: true });
});

describe('QA with real Docker', () => {
  let game: Game;
  let gameDir: string;

  it('installs the environment and unlocks stage 1 as a snapshot commit on player/ticket-1', async () => {
    gameDir = dir;
    game = createGame(gameDir);
    await game.init();
    expect((await game.checkPrerequisites()).dockerState).toBe('running');
    await game.installEnvironment();
    await game.nextAssignment();
    await game.installEnvironment();
    expect((await game.refreshEnvironment()).ready).toBe(true);

    const ws = await workspace();
    expect(await ws.currentBranch()).toBe('player/ticket-1');
    expect((await ws.git(['log', '--format=%s', 'stage-1'])).trim()).toBe('SupportDesk release 1.1');
    expect((await ws.git(['rev-list', '--count', 'HEAD'])).trim()).toBe('1');
    expect((await ws.git(['config', 'core.autocrlf'])).trim()).toBe('false');
    // Snapshot import keeps LF line endings.
    const crlf = await docker.exec(runtime.names.container, ['grep', '-rlI', '--exclude-dir=node_modules', '--exclude-dir=.git', '\r', '.'], {
      user: 'node',
      workdir: '/workspaces/supportdesk',
    });
    expect(crlf.stdout.toString('utf8').trim()).toBe('');
    // The package lives in the app data folder, not in the volume.
    const listing = await docker.exec(runtime.names.container, ['ls', '-a', '/workspaces/supportdesk'], { user: 'node' });
    expect(listing.stdout.toString('utf8')).not.toMatch(/gate2|reference\.patch|hints/);
    expect(rules.findTicket(game.current, 1)!.stageCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('runs QA on the buggy stage: Gate 1 passes, Gate 2 fails', async () => {
    await game.move(1, 'inProgress');
    const { result, peakQaMiB, peakWorkspaceMiB } = await measureDuring(submit(game, 1));
    const attempt = result.ticket.attempts.at(-1)!;
    console.log(`buggy QA: ${result.seconds.toFixed(1)} s, peak QA container ${peakQaMiB.toFixed(0)} MiB, workspace ${peakWorkspaceMiB.toFixed(0)} MiB`);
    expect(result.ticket.status).toBe('inProgress');
    expect(attempt.result).toMatchObject({ gate: 2, status: 'failed' });
    expect(attempt.result.tests.filter((test) => test.status === 'failed').length).toBeGreaterThan(0);
    expect(result.ticket.comments.at(-1)!.kind).toBe('gate2Failed');
    expect((await docker.containersWithRole('qa')).filter((name) => name.startsWith(`${PREFIX}-qa-`))).toEqual([]);
  });

  it('counts an infinite loop as a timeout and removes the QA container', async () => {
    await game.updateSettings({ qaTimeoutSeconds: 45 });
    const ws = await workspace();
    // A synchronous infinite loop when the ticket list module loads (the dev server is not running).
    await docker.execChecked(runtime.names.container, ['sh', '-c', 'printf "\\nwhile (true) {}\\n" >> client/src/pages/TicketList.tsx'], {
      user: 'node',
      workdir: '/workspaces/supportdesk',
    });
    const { ticket, seconds } = await submit(game, 1);
    console.log(`timeout QA: ${seconds.toFixed(1)} s`);
    expect(ticket.status).toBe('inProgress');
    expect(ticket.attempts.at(-1)!.result.status).toBe('timeout');
    expect(ticket.comments.at(-1)).toMatchObject({ kind: 'timeout', timeoutSeconds: 45 });
    expect((await docker.containersWithRole('qa')).filter((name) => name.startsWith(`${PREFIX}-qa-`))).toEqual([]);
    await ws.git(['checkout', '--', 'client/src/pages/TicketList.tsx']);
    await game.updateSettings({ qaTimeoutSeconds: 180 });
  });

  it('passes both gates after reference.patch is applied inside the workspace container', async () => {
    const ws = await workspace();
    await ws.applyPatch(await readFile(join(supportdesk, 'qa', 'stages', 'stage-1', 'reference.patch'), 'utf8'));
    const { result, peakQaMiB } = await measureDuring(submit(game, 1));
    console.log(`fixed QA: ${result.seconds.toFixed(1)} s, peak QA container ${peakQaMiB.toFixed(0)} MiB`);
    expect(result.ticket.attempts.at(-1)!.result).toMatchObject({ gate: 2, status: 'passed' });
    expect(result.ticket.status).toBe('codeReview');
    expect(result.ticket.playerDiff).toContain('client/src/pages/TicketDetails.tsx');
    expect(result.ticket.playerDiff).toContain('TicketDetails.navigation.test.tsx');
    // QA never touched the player's files.
    expect((await ws.git(['status', '--porcelain'])).trim().split('\n').sort()).toEqual([
      '?? client/src/pages/TicketDetails.navigation.test.tsx',
      'M client/src/pages/TicketDetails.tsx',
    ]);
    await game.acceptReview(1);
    expect(rules.findTicket(game.current, 1)!.status).toBe('done');
  });

  it('unlocks stage 2 on a new branch without modifying player/ticket-1', async () => {
    const ws = await workspace();
    const before = (await ws.git(['rev-parse', 'player/ticket-1'])).trim();
    await game.nextAssignment();
    expect(await ws.currentBranch()).toBe('player/ticket-2');
    expect((await ws.git(['rev-parse', 'player/ticket-1'])).trim()).toBe(before);
    // The uncommitted fix of ticket 1 was stashed, not lost.
    expect(await ws.git(['stash', 'list'])).toContain('before ticket 2');
    expect((await ws.git(['log', '--format=%s', 'stage-2'])).trim().split('\n')).toEqual(['SupportDesk release 1.2', 'SupportDesk release 1.1']);
  });

  it('exports progress, deletes the volume and restores it', async () => {
    const save = join(dir, 'progress.bdsave');
    await game.exportProgress(save);
    const ws = await workspace();
    const head = (await ws.git(['rev-parse', 'HEAD'])).trim();
    await ws.destroy();
    expect(await docker.volumeExists(runtime.names.volume)).toBe(false);

    const freshDir = await mkdtemp(join(dir, 'restore-'));
    const fresh = createGame(freshDir);
    await fresh.init();
    const { token, summary } = await fresh.inspectSave(save, 'progress.bdsave');
    expect(summary).toMatchObject({ ticketsDone: 1, currentTicket: 2, overwritesProgress: false });
    await fresh.restoreProgress(token);
    expect(fresh.current.currentTicket).toBe(2);
    expect(rules.findTicket(fresh.current, 1)!.status).toBe('done');
    const restored = await workspace();
    expect(await restored.currentBranch()).toBe('player/ticket-2');
    expect((await restored.git(['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect(await restored.git(['branch', '--list', 'player/*'])).toContain('player/ticket-1');
    // node_modules are reinstalled from the cache volume, without the network.
    expect((await fresh.refreshEnvironment()).ready).toBe(false);
    await fresh.installEnvironment();
    expect((await fresh.refreshEnvironment()).ready).toBe(true);
    game = fresh;
    gameDir = freshDir;
  });

  it('recovers QA interrupted by a closed app and removes the leftover container', async () => {
    await game.move(2, 'inProgress');
    await game.move(2, 'inQa');
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const running = (await docker.containersWithRole('qa')).filter((name) => name.startsWith(`${PREFIX}-qa-`));
    expect(running).toHaveLength(1);

    // A new app instance on the same data folder, as after a crash.
    const restarted = createGame(gameDir);
    await restarted.init();
    await restarted.cleanupLeftovers();
    const ticket = rules.findTicket(restarted.current, 2)!;
    expect(ticket.status).toBe('inProgress');
    expect(ticket.attempts).toHaveLength(0);
    expect(ticket.comments.at(-1)!.kind).toBe('interrupted');
    expect((await docker.containersWithRole('qa')).filter((name) => name.startsWith(`${PREFIX}-qa-`))).toEqual([]);
    await game.waitForQa().catch(() => {});
  });
});
