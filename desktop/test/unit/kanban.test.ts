import { describe, expect, it } from 'vitest';
import * as rules from '../../src/shared/kanban.ts';
import type { RuleContext } from '../../src/shared/kanban.ts';
import { COLUMNS } from '../../src/shared/types.ts';
import type { Column, GameState, QaResult } from '../../src/shared/types.ts';

function context(): RuleContext {
  let next = 0;
  return { now: '2026-10-26T10:00:00.000Z', id: () => `id-${(next += 1)}` };
}

const ctx = context();
const result = (status: QaResult['status'], gate: 1 | 2 = 2): QaResult => ({
  ticket: 1,
  gate,
  status,
  message: '',
  tests: [
    { name: 'a passing test', status: 'passed' },
    ...(status === 'failed' ? [{ name: 'a failing test', status: 'failed' as const, error: 'boom' }] : []),
    ...(status === 'timeout' ? [{ name: 'an unfinished test', status: 'unfinished' as const }] : []),
  ],
  durationMs: 1000,
});
const outcome = (status: QaResult['status'], gate: 1 | 2 = 2) => ({
  startedAt: ctx.now,
  branch: 'player/ticket-1',
  branchWarning: false,
  timeoutSeconds: 180,
  result: result(status, gate),
  playerDiff: 'diff --git a/x b/x',
});

function withTicket(status: Column = 'todo'): GameState {
  let state = rules.unlockTicket(rules.createInitialState(ctx), 1, 'abc', ctx);
  const path: Column[] = ['inProgress', 'inQa', 'codeReview', 'done'];
  for (const step of path.slice(0, path.indexOf(status) + 1)) {
    if (step === 'inProgress' || step === 'inQa') {
      state = rules.playerMove(state, 1, step, ctx);
    } else if (step === 'codeReview') {
      state = rules.recordQaResult(state, 1, outcome('passed'), ctx);
    } else {
      state = rules.acceptReview(state, 1, ctx);
    }
  }
  return state;
}

const ticketStatus = (state: GameState, ticket = 1) => rules.findTicket(state, ticket)!.status;

describe('initial state', () => {
  it('starts with no ticket and a welcome message', () => {
    const state = rules.createInitialState(ctx, 'pt');
    expect(state.currentTicket).toBeNull();
    expect(state.inbox.map((message) => message.kind)).toEqual(['welcome']);
    expect(state.settings).toEqual({ language: 'pt', qaTimeoutSeconds: 180, theme: 'system' });
    expect(rules.nextTicketNumber(state)).toBe(1);
  });
});

describe('player moves', () => {
  const allowed = [
    ['todo', 'inProgress'],
    ['inProgress', 'inQa'],
  ];

  for (const from of COLUMNS) {
    for (const to of COLUMNS) {
      const ok = allowed.some(([a, b]) => a === from && b === to);
      it(`${ok ? 'allows' : 'forbids'} ${from} → ${to}`, () => {
        expect(rules.isPlayerMoveAllowed(from, to)).toBe(ok);
        const state = withTicket(from);
        if (ok) {
          expect(ticketStatus(rules.playerMove(state, 1, to, ctx))).toBe(to);
        } else {
          expect(() => rules.playerMove(state, 1, to, ctx)).toThrow(expect.objectContaining({ code: 'moveNotAllowed' }));
        }
      });
    }
  }

  it('cannot cancel QA', () => {
    const state = withTicket('inQa');
    expect(() => rules.playerMove(state, 1, 'inProgress', ctx)).toThrow(expect.objectContaining({ code: 'moveNotAllowed' }));
    expect(() => rules.playerMove(state, 1, 'todo', ctx)).toThrow(expect.objectContaining({ code: 'moveNotAllowed' }));
  });

  it('marks QA as started when the card enters In QA', () => {
    const state = withTicket('inQa');
    expect(rules.findTicket(state, 1)!.qaStartedAt).toBe(ctx.now);
  });

  it('only moves the active ticket', () => {
    const state = withTicket('todo');
    expect(() => rules.playerMove(state, 2, 'inProgress', ctx)).toThrow(expect.objectContaining({ code: 'noSuchTicket' }));
  });

  it('appends every transition to the activity log', () => {
    const state = withTicket('done');
    expect(state.activity.map((entry) => [entry.from, entry.to, entry.actor])).toEqual([
      [null, 'todo', 'system'],
      ['todo', 'inProgress', 'player'],
      ['inProgress', 'inQa', 'player'],
      ['inQa', 'codeReview', 'system'],
      ['codeReview', 'done', 'player'],
    ]);
  });
});

describe('one active ticket at a time', () => {
  it('unlocks the next ticket only after the current one is Done', () => {
    for (const status of ['todo', 'inProgress', 'inQa', 'codeReview'] as Column[]) {
      const state = withTicket(status);
      expect(rules.nextTicketNumber(state)).toBeNull();
      expect(() => rules.unlockTicket(state, 2, 'def', ctx)).toThrow(expect.objectContaining({ code: 'ticketNotDone' }));
    }
    const done = withTicket('done');
    expect(rules.nextTicketNumber(done)).toBe(2);
    const next = rules.unlockTicket(done, 2, 'def', ctx);
    expect(next.currentTicket).toBe(2);
    expect(next.inbox.filter((message) => message.kind === 'assignment').map((message) => message.ticket)).toEqual([1, 2]);
  });

  it('unlocks tickets in order', () => {
    expect(() => rules.unlockTicket(rules.createInitialState(ctx), 2, 'x', ctx)).toThrow(expect.objectContaining({ code: 'wrongTicket' }));
  });

  it('makes Done tickets read-only', () => {
    let state = withTicket('done');
    state = rules.unlockTicket(state, 2, 'def', ctx);
    for (const to of COLUMNS) {
      expect(() => rules.playerMove(state, 1, to, ctx)).toThrow(expect.objectContaining({ code: 'notActiveTicket' }));
    }
    expect(() => rules.revealHint(state, 1, 3, ctx)).toThrow(expect.objectContaining({ code: 'notActiveTicket' }));
  });

  it('sends the completion message after the fourth ticket', () => {
    let state = rules.createInitialState(ctx);
    for (let ticket = 1; ticket <= 4; ticket += 1) {
      state = rules.unlockTicket(state, ticket, 'x', ctx);
      state = rules.playerMove(state, ticket, 'inProgress', ctx);
      state = rules.playerMove(state, ticket, 'inQa', ctx);
      state = rules.recordQaResult(state, ticket, { ...outcome('passed'), result: { ...result('passed'), ticket } }, ctx);
      state = rules.acceptReview(state, ticket, ctx);
    }
    expect(state.inbox.at(-1)!.kind).toBe('completion');
    expect(rules.nextTicketNumber(state)).toBeNull();
    expect(() => rules.unlockTicket(state, 5, 'x', ctx)).toThrow(expect.objectContaining({ code: 'noMoreTickets' }));
  });
});

describe('QA results', () => {
  it('moves a passing ticket to Code Review and keeps the player diff', () => {
    const state = rules.recordQaResult(withTicket('inQa'), 1, outcome('passed'), ctx);
    const ticket = rules.findTicket(state, 1)!;
    expect(ticket.status).toBe('codeReview');
    expect(ticket.attempts).toHaveLength(1);
    expect(ticket.playerDiff).toBe('diff --git a/x b/x');
    expect(ticket.comments.at(-1)!.kind).toBe('passed');
    expect(ticket.qaStartedAt).toBeNull();
  });

  it('returns a failing ticket to In Progress with a comment naming the gate and the failing tests', () => {
    for (const gate of [1, 2] as const) {
      const state = rules.recordQaResult(withTicket('inQa'), 1, outcome('failed', gate), ctx);
      const ticket = rules.findTicket(state, 1)!;
      expect(ticket.status).toBe('inProgress');
      expect(ticket.comments.at(-1)).toMatchObject({
        kind: gate === 1 ? 'gate1Failed' : 'gate2Failed',
        failing: [{ name: 'a failing test', error: 'boom' }],
      });
      expect(state.activity.at(-1)).toMatchObject({ from: 'inQa', to: 'inProgress', reason: 'qaFailed' });
    }
  });

  it('counts a timeout as a failed attempt and lists unfinished tests', () => {
    const state = rules.recordQaResult(withTicket('inQa'), 1, outcome('timeout'), ctx);
    const ticket = rules.findTicket(state, 1)!;
    expect(ticket.status).toBe('inProgress');
    expect(ticket.attempts).toHaveLength(1);
    expect(ticket.comments.at(-1)).toMatchObject({ kind: 'timeout', timeoutSeconds: 180, unfinished: ['an unfinished test'] });
  });

  it('numbers attempts and keeps all of them', () => {
    let state = rules.recordQaResult(withTicket('inQa'), 1, outcome('failed'), ctx);
    state = rules.playerMove(state, 1, 'inQa', ctx);
    state = rules.recordQaResult(state, 1, outcome('passed'), ctx);
    expect(rules.findTicket(state, 1)!.attempts.map((attempt) => [attempt.number, attempt.result.status])).toEqual([
      [1, 'failed'],
      [2, 'passed'],
    ]);
  });

  it('does not count an infrastructure error as an attempt', () => {
    const state = rules.recordQaError(withTicket('inQa'), 1, 'Docker stopped', ctx);
    const ticket = rules.findTicket(state, 1)!;
    expect(ticket.status).toBe('inProgress');
    expect(ticket.attempts).toHaveLength(0);
    expect(ticket.comments.at(-1)).toMatchObject({ kind: 'error', detail: 'Docker stopped' });
  });

  it('only accepts results for a ticket in In QA', () => {
    expect(() => rules.recordQaResult(withTicket('inProgress'), 1, outcome('passed'), ctx)).toThrow(
      expect.objectContaining({ code: 'wrongColumn' }),
    );
  });
});

describe('interrupted QA', () => {
  it('moves a card found in In QA back to In Progress without counting an attempt', () => {
    const state = rules.recoverInterruptedQa(withTicket('inQa'), ctx);
    const ticket = rules.findTicket(state, 1)!;
    expect(ticket.status).toBe('inProgress');
    expect(ticket.attempts).toHaveLength(0);
    expect(ticket.qaStartedAt).toBeNull();
    expect(ticket.comments.at(-1)!.kind).toBe('interrupted');
    expect(state.activity.at(-1)).toMatchObject({ from: 'inQa', to: 'inProgress', actor: 'system', reason: 'qaInterrupted' });
  });

  it('returns the same state when nothing was interrupted', () => {
    const state = withTicket('inProgress');
    expect(rules.recoverInterruptedQa(state, ctx)).toBe(state);
  });
});

describe('senior-dev hints', () => {
  it('reveals hints one at a time, then the solution', () => {
    let state = withTicket('inProgress');
    expect(() => rules.revealSolution(state, 1, 3, ctx)).toThrow(expect.objectContaining({ code: 'hintsRemaining' }));
    for (let hint = 1; hint <= 3; hint += 1) {
      state = rules.revealHint(state, 1, 3, ctx);
      expect(rules.findTicket(state, 1)!.hintsRevealed).toBe(hint);
    }
    expect(() => rules.revealHint(state, 1, 3, ctx)).toThrow(expect.objectContaining({ code: 'noMoreHints' }));
    state = rules.revealSolution(state, 1, 3, ctx);
    const ticket = rules.findTicket(state, 1)!;
    expect(ticket.solutionRevealed).toBe(true);
    expect(ticket.status).toBe('inProgress');
    expect(ticket.conversation.map((entry) => entry.kind)).toEqual([
      'question', 'hint', 'question', 'hint', 'question', 'hint', 'solutionRequest', 'solution',
    ]);
    expect(() => rules.revealSolution(state, 1, 3, ctx)).toThrow(expect.objectContaining({ code: 'solutionAlreadyRevealed' }));
  });

  it('only answers from an In Progress card', () => {
    for (const status of ['todo', 'inQa', 'codeReview', 'done'] as Column[]) {
      expect(() => rules.revealHint(withTicket(status), 1, 3, ctx)).toThrow();
    }
  });
});

describe('branch warning', () => {
  it('adds a warning comment without moving the card', () => {
    const state = rules.addBranchWarning(withTicket('inQa'), 1, 'main', ctx);
    const ticket = rules.findTicket(state, 1)!;
    expect(ticket.status).toBe('inQa');
    expect(ticket.comments.at(-1)).toMatchObject({ kind: 'branchWarning', branch: 'main' });
  });
});
