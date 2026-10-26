import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRuntime } from '../../src/main/fake-runtime.ts';
import { Game } from '../../src/main/game.ts';
import { LocalContentSource } from '../../src/main/services/content/local.ts';
import type { ContentSource } from '../../src/main/services/content/source.ts';
import { PackageStore } from '../../src/main/services/content/store.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { StateStore } from '../../src/main/services/state.ts';
import * as rules from '../../src/shared/kanban.ts';

// The real SupportDesk checkout and the manifest from `npm run build:stages`.
const root = resolve(import.meta.dirname, '..', '..');
const localSource = () =>
  new LocalContentSource({
    repoPath: resolve(root, '..', 'supportdesk'),
    manifestPath: join(root, 'build', 'stage-packages', 'manifest.json'),
    runner: runCommand,
  });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-game-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function createGame(options: { scenario?: object; content?: ContentSource } = {}) {
  const runtime = new FakeRuntime(JSON.stringify({ qaDelayMs: 1, ...options.scenario }));
  const game = new Game({
    store: new StateStore(dir),
    packages: new PackageStore(join(dir, 'packages')),
    content: options.content ?? localSource(),
    runtime,
    appVersion: '0.1.0',
    versions: { electron: 'test', node: process.versions.node, chrome: 'test' },
  });
  return { game, runtime };
}

const status = (game: Game, ticket = 1) => rules.findTicket(game.current, ticket)!.status;

describe('Game', () => {
  it('unlocks stage 1 from the local source and stores its package', async () => {
    const { game } = createGame();
    await game.init();
    await game.nextAssignment();
    expect(game.current.currentTicket).toBe(1);
    expect(status(game)).toBe('todo');
    expect(game.snapshot().titles[1].en).toMatch(/^SD-214:/);
    expect(game.snapshot().titles[1].pt).toMatch(/^SD-214:/);
    expect(game.snapshot().hintsTotal[1]).toBe(3);
    const content = await game.ticketContent(1, 'en');
    expect(content.ticketMarkdown).toContain('Previous');
    expect(content.hints).toEqual([]);
    expect(content.solutionMarkdown).toBeNull();
    expect(content.reviewMarkdown).toBeNull();
    expect(content.referencePatch).toBeNull();
  });

  it('leaves the workspace untouched when the download fails, and can retry', async () => {
    const failing: ContentSource = {
      kind: 'github',
      describe: () => 'mock',
      fetchStage: vi.fn().mockRejectedValueOnce(new Error('network down')).mockImplementation((stage: number) => localSource().fetchStage(stage)),
    };
    const { game, runtime } = createGame({ content: failing });
    const importStage = vi.spyOn(runtime, 'importStage');
    await game.init();
    await expect(game.nextAssignment()).rejects.toThrow('network down');
    expect(importStage).not.toHaveBeenCalled();
    expect(game.current.tickets).toEqual([]);
    expect(game.snapshot().busy).toBeNull();
    await game.nextAssignment();
    expect(importStage).toHaveBeenCalledTimes(1);
    expect(game.current.currentTicket).toBe(1);
  });

  it('plays a ticket: QA fails, hints, solution, QA passes, review, Done, next ticket', async () => {
    const { game } = createGame({ scenario: { qa: ['gate2', 'passed'] } });
    await game.init();
    await game.nextAssignment();
    await game.move(1, 'inProgress');

    await game.move(1, 'inQa');
    expect(status(game)).toBe('inQa');
    expect(game.snapshot().busy).toBe('qa');
    await game.waitForQa();
    expect(status(game)).toBe('inProgress');
    expect(rules.findTicket(game.current, 1)!.comments.at(-1)!.kind).toBe('gate2Failed');

    for (let hint = 1; hint <= 3; hint += 1) {
      await game.askSenior(1);
      expect((await game.ticketContent(1, 'pt')).hints).toHaveLength(hint);
    }
    await game.revealSolution(1);
    const revealed = await game.ticketContent(1, 'en');
    expect(revealed.solutionMarkdown).toContain('Root cause');
    expect(revealed.referencePatch).toContain('diff --git');
    expect(revealed.reviewMarkdown).toBeNull();

    await game.move(1, 'inQa');
    await game.waitForQa();
    expect(status(game)).toBe('codeReview');
    const review = await game.ticketContent(1, 'en');
    expect(review.reviewMarkdown).toContain('Code review');
    expect(review.playerDiff).toContain('fixed by the player');

    await expect(game.nextAssignment()).rejects.toMatchObject({ code: 'ticketNotDone' });
    await game.acceptReview(1);
    expect(status(game)).toBe('done');
    await game.nextAssignment();
    expect(game.current.currentTicket).toBe(2);
    expect(game.current.inbox.filter((message) => message.kind === 'assignment')).toHaveLength(2);
  });

  it('enforces the drag rules in the main process', async () => {
    const { game } = createGame();
    await game.init();
    await game.nextAssignment();
    await expect(game.move(1, 'inQa')).rejects.toMatchObject({ code: 'moveNotAllowed' });
    await expect(game.move(1, 'done')).rejects.toMatchObject({ code: 'moveNotAllowed' });
    await game.move(1, 'inProgress');
    await expect(game.move(1, 'codeReview')).rejects.toMatchObject({ code: 'moveNotAllowed' });
    await expect(game.move(1, 'todo')).rejects.toMatchObject({ code: 'moveNotAllowed' });
    await expect(game.move(2, 'inProgress')).rejects.toMatchObject({ code: 'noSuchTicket' });
  });

  it('does not move the card when the environment is not ready', async () => {
    const { game } = createGame({ scenario: { environmentReady: false } });
    await game.init();
    await game.nextAssignment();
    await game.move(1, 'inProgress');
    await expect(game.move(1, 'inQa')).rejects.toMatchObject({ code: 'environmentNotReady' });
    expect(status(game)).toBe('inProgress');
  });

  it('pauses Docker actions while Docker is stopped', async () => {
    const { game } = createGame({ scenario: { docker: 'notRunning' } });
    await game.init();
    await expect(game.nextAssignment()).rejects.toMatchObject({ code: 'dockerUnavailable' });
    expect(game.snapshot().dockerState).toBe('notRunning');
  });

  it('warns when QA starts on another branch, and still evaluates', async () => {
    const { game } = createGame({ scenario: { branch: 'main', qa: ['passed'] } });
    await game.init();
    await game.nextAssignment();
    await game.move(1, 'inProgress');
    await game.move(1, 'inQa');
    await game.waitForQa();
    const ticket = rules.findTicket(game.current, 1)!;
    expect(ticket.comments.map((comment) => comment.kind)).toEqual(['branchWarning', 'passed']);
    expect(ticket.attempts[0]).toMatchObject({ branch: 'main', branchWarning: true });
    expect(ticket.status).toBe('codeReview');
  });

  it('does not count an infrastructure error as an attempt', async () => {
    const { game } = createGame({ scenario: { qa: ['error'] } });
    await game.init();
    await game.nextAssignment();
    await game.move(1, 'inProgress');
    await game.move(1, 'inQa');
    await game.waitForQa();
    const ticket = rules.findTicket(game.current, 1)!;
    expect(ticket.status).toBe('inProgress');
    expect(ticket.attempts).toHaveLength(0);
    expect(ticket.comments.at(-1)).toMatchObject({ kind: 'error' });
  });

  it('recovers a QA run interrupted by a closed app on the next start', async () => {
    const ctx = { now: new Date().toISOString(), id: () => crypto.randomUUID() };
    let state = rules.unlockTicket(rules.createInitialState(ctx), 1, 'abc', ctx);
    state = rules.playerMove(state, 1, 'inProgress', ctx);
    state = rules.playerMove(state, 1, 'inQa', ctx);
    await writeFile(join(dir, 'state.json'), JSON.stringify(state));
    const { game } = createGame();
    await game.init();
    const ticket = rules.findTicket(game.current, 1)!;
    expect(ticket.status).toBe('inProgress');
    expect(ticket.attempts).toHaveLength(0);
    expect(ticket.comments.at(-1)!.kind).toBe('interrupted');
    // Persisted, so a second restart does not add another comment.
    const { game: again } = createGame();
    await again.init();
    expect(rules.findTicket(again.current, 1)!.comments).toHaveLength(1);
  });

  it('clamps the QA timeout setting', async () => {
    const { game } = createGame();
    await game.init();
    await game.updateSettings({ qaTimeoutSeconds: 5 });
    expect(game.current.settings.qaTimeoutSeconds).toBe(30);
    await game.updateSettings({ qaTimeoutSeconds: 240, language: 'pt' });
    expect(game.current.settings).toMatchObject({ qaTimeoutSeconds: 240, language: 'pt' });
  });
});
