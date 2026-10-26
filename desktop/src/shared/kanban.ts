/**
 * The Kanban rules as pure functions: each takes a state and returns a new one, or throws a
 * GameRuleError. The main process applies every change through these functions, so the rules
 * hold no matter what the renderer sends.
 */
import { DEFAULT_QA_TIMEOUT_SECONDS, TICKET_COUNT } from './types.ts';
import type {
  ActivityEntry,
  Column,
  GameState,
  Language,
  QaAttempt,
  QaComment,
  QaResult,
  TicketState,
} from './types.ts';

export type RuleCode =
  | 'noSuchTicket'
  | 'notActiveTicket'
  | 'ticketNotDone'
  | 'noMoreTickets'
  | 'wrongTicket'
  | 'moveNotAllowed'
  | 'wrongColumn'
  | 'noMoreHints'
  | 'hintsRemaining'
  | 'solutionAlreadyRevealed';

export class GameRuleError extends Error {
  readonly code: RuleCode;

  constructor(code: RuleCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/** Clock and id source, injected so the rules stay deterministic in tests. */
export interface RuleContext {
  now: string;
  id: () => string;
}

/** The only moves a player may make. Every other transition is made by the system. */
export const PLAYER_MOVES: Readonly<Partial<Record<Column, readonly Column[]>>> = {
  todo: ['inProgress'],
  inProgress: ['inQa'],
};

export function isPlayerMoveAllowed(from: Column, to: Column): boolean {
  return PLAYER_MOVES[from]?.includes(to) ?? false;
}

export function createInitialState(ctx: RuleContext, language: Language = 'en'): GameState {
  return {
    schemaVersion: 2,
    createdAt: ctx.now,
    currentTicket: null,
    tickets: [],
    activity: [],
    inbox: [{ id: ctx.id(), kind: 'welcome', at: ctx.now, read: false }],
    settings: { language, qaTimeoutSeconds: DEFAULT_QA_TIMEOUT_SECONDS, theme: 'system' },
  };
}

export function findTicket(state: GameState, ticket: number): TicketState | undefined {
  return state.tickets.find((item) => item.ticket === ticket);
}

function requireTicket(state: GameState, ticket: number): TicketState {
  const found = findTicket(state, ticket);
  if (!found) {
    throw new GameRuleError('noSuchTicket', `Ticket ${ticket} is not unlocked`);
  }
  return found;
}

function requireActive(state: GameState, ticket: number): TicketState {
  const found = requireTicket(state, ticket);
  if (state.currentTicket !== ticket) {
    throw new GameRuleError('notActiveTicket', `Ticket ${ticket} is not the active ticket`);
  }
  return found;
}

function requireColumn(ticket: TicketState, ...columns: Column[]): void {
  if (!columns.includes(ticket.status)) {
    throw new GameRuleError('wrongColumn', `Ticket ${ticket.ticket} is in ${ticket.status}, expected ${columns.join(' or ')}`);
  }
}

function updateTicket(state: GameState, ticket: number, change: (current: TicketState) => TicketState): GameState {
  return {
    ...state,
    tickets: state.tickets.map((item) => (item.ticket === ticket ? change(item) : item)),
  };
}

function move(
  state: GameState,
  ticket: number,
  to: Column,
  ctx: RuleContext,
  actor: ActivityEntry['actor'],
  reason: ActivityEntry['reason'],
  change: (current: TicketState) => TicketState = (current) => current,
): GameState {
  const from = requireTicket(state, ticket).status;
  const next = updateTicket(state, ticket, (current) => ({ ...change(current), status: to }));
  return { ...next, activity: [...next.activity, { ticket, from, to, at: ctx.now, actor, reason }] };
}

/** The ticket "Get Next Assignment" would unlock, or null when it is not allowed right now. */
export function nextTicketNumber(state: GameState): number | null {
  if (state.currentTicket !== null && requireTicket(state, state.currentTicket).status !== 'done') {
    return null;
  }
  const next = state.tickets.length + 1;
  return next <= TICKET_COUNT ? next : null;
}

export function assertCanUnlock(state: GameState, ticket: number): void {
  if (state.currentTicket !== null && requireTicket(state, state.currentTicket).status !== 'done') {
    throw new GameRuleError('ticketNotDone', `Ticket ${state.currentTicket} must be Done first`);
  }
  if (state.tickets.length >= TICKET_COUNT) {
    throw new GameRuleError('noMoreTickets');
  }
  if (ticket !== state.tickets.length + 1) {
    throw new GameRuleError('wrongTicket', `The next ticket is ${state.tickets.length + 1}, not ${ticket}`);
  }
}

export function unlockTicket(state: GameState, ticket: number, stageCommit: string | null, ctx: RuleContext): GameState {
  assertCanUnlock(state, ticket);
  const created: TicketState = {
    ticket,
    status: 'todo',
    unlockedAt: ctx.now,
    stageCommit,
    attempts: [],
    comments: [],
    hintsRevealed: 0,
    solutionRevealed: false,
    reviewAcceptedAt: null,
    qaStartedAt: null,
    playerDiff: null,
    conversation: [],
  };
  return {
    ...state,
    currentTicket: ticket,
    tickets: [...state.tickets, created],
    activity: [...state.activity, { ticket, from: null, to: 'todo', at: ctx.now, actor: 'system', reason: 'unlocked' }],
    inbox: [...state.inbox, { id: ctx.id(), kind: 'assignment', ticket, at: ctx.now, read: false }],
  };
}

/** A move the player asked for (drag and drop). Moving to In QA marks QA as started. */
export function playerMove(state: GameState, ticket: number, to: Column, ctx: RuleContext): GameState {
  const current = requireActive(state, ticket);
  if (!isPlayerMoveAllowed(current.status, to)) {
    throw new GameRuleError('moveNotAllowed', `Moving ticket ${ticket} from ${current.status} to ${to} is not allowed`);
  }
  if (to === 'inQa') {
    return move(state, ticket, to, ctx, 'player', 'submitted', (item) => ({ ...item, qaStartedAt: ctx.now }));
  }
  return move(state, ticket, to, ctx, 'player', 'started');
}

/** Adds a warning comment when QA starts on a branch other than player/ticket-N. */
export function addBranchWarning(state: GameState, ticket: number, branch: string | null, ctx: RuleContext): GameState {
  const comment: QaComment = { id: ctx.id(), at: ctx.now, kind: 'branchWarning', branch };
  return updateTicket(state, ticket, (item) => ({ ...item, comments: [...item.comments, comment] }));
}

export function commentForResult(result: QaResult, attemptId: string, timeoutSeconds: number, ctx: RuleContext): QaComment {
  const base = { id: ctx.id(), at: ctx.now, attemptId };
  const failing = result.tests
    .filter((test) => test.status === 'failed')
    .map((test) => ({ name: test.name, ...(test.error !== undefined && { error: test.error }) }));
  if (result.status === 'passed') {
    return { ...base, kind: 'passed' };
  }
  if (result.status === 'timeout') {
    const unfinished = result.tests.filter((test) => test.status === 'unfinished').map((test) => test.name);
    return { ...base, kind: 'timeout', timeoutSeconds, failing, unfinished };
  }
  return { ...base, kind: result.gate === 1 ? 'gate1Failed' : 'gate2Failed', failing };
}

export interface QaOutcome {
  startedAt: string;
  branch: string | null;
  branchWarning: boolean;
  timeoutSeconds: number;
  result: QaResult;
  /** The player's diff against the stage commit, kept for the review when QA passes. */
  playerDiff?: string | null;
}

/** Records a finished QA run: passing moves the card to Code Review, anything else back to In Progress. */
export function recordQaResult(state: GameState, ticket: number, outcome: QaOutcome, ctx: RuleContext): GameState {
  const current = requireActive(state, ticket);
  requireColumn(current, 'inQa');
  const attempt: QaAttempt = {
    id: ctx.id(),
    number: current.attempts.length + 1,
    startedAt: outcome.startedAt,
    finishedAt: ctx.now,
    branch: outcome.branch,
    branchWarning: outcome.branchWarning,
    timeoutSeconds: outcome.timeoutSeconds,
    result: outcome.result,
  };
  const comment = commentForResult(outcome.result, attempt.id, outcome.timeoutSeconds, ctx);
  const passed = outcome.result.status === 'passed';
  const reason = passed ? 'qaPassed' : outcome.result.status === 'timeout' ? 'qaTimeout' : 'qaFailed';
  return move(state, ticket, passed ? 'codeReview' : 'inProgress', ctx, 'system', reason, (item) => ({
    ...item,
    qaStartedAt: null,
    attempts: [...item.attempts, attempt],
    comments: [...item.comments, comment],
    playerDiff: passed ? (outcome.playerDiff ?? item.playerDiff) : item.playerDiff,
  }));
}

/** QA could not run (for example Docker stopped). Not the player's fault, so not an attempt. */
export function recordQaError(state: GameState, ticket: number, detail: string, ctx: RuleContext): GameState {
  const current = requireActive(state, ticket);
  requireColumn(current, 'inQa');
  const comment: QaComment = { id: ctx.id(), at: ctx.now, kind: 'error', detail };
  return move(state, ticket, 'inProgress', ctx, 'system', 'qaError', (item) => ({
    ...item,
    qaStartedAt: null,
    comments: [...item.comments, comment],
  }));
}

/** On startup: a card still in In QA means the app closed during QA. Not counted as an attempt. */
export function recoverInterruptedQa(state: GameState, ctx: RuleContext): GameState {
  let next = state;
  for (const ticket of state.tickets.filter((item) => item.status === 'inQa')) {
    const comment: QaComment = { id: ctx.id(), at: ctx.now, kind: 'interrupted' };
    next = move(next, ticket.ticket, 'inProgress', ctx, 'system', 'qaInterrupted', (item) => ({
      ...item,
      qaStartedAt: null,
      comments: [...item.comments, comment],
    }));
  }
  return next;
}

export function revealHint(state: GameState, ticket: number, totalHints: number, ctx: RuleContext): GameState {
  const current = requireActive(state, ticket);
  requireColumn(current, 'inProgress');
  if (current.hintsRevealed >= totalHints) {
    throw new GameRuleError('noMoreHints');
  }
  return updateTicket(state, ticket, (item) => ({
    ...item,
    hintsRevealed: item.hintsRevealed + 1,
    conversation: [
      ...item.conversation,
      { at: ctx.now, from: 'player', kind: 'question' },
      { at: ctx.now, from: 'senior', kind: 'hint', hintIndex: item.hintsRevealed },
    ],
  }));
}

export function revealSolution(state: GameState, ticket: number, totalHints: number, ctx: RuleContext): GameState {
  const current = requireActive(state, ticket);
  requireColumn(current, 'inProgress');
  if (current.hintsRevealed < totalHints) {
    throw new GameRuleError('hintsRemaining');
  }
  if (current.solutionRevealed) {
    throw new GameRuleError('solutionAlreadyRevealed');
  }
  return updateTicket(state, ticket, (item) => ({
    ...item,
    solutionRevealed: true,
    conversation: [
      ...item.conversation,
      { at: ctx.now, from: 'player', kind: 'solutionRequest' },
      { at: ctx.now, from: 'senior', kind: 'solution' },
    ],
  }));
}

export function acceptReview(state: GameState, ticket: number, ctx: RuleContext): GameState {
  const current = requireActive(state, ticket);
  requireColumn(current, 'codeReview');
  const next = move(state, ticket, 'done', ctx, 'player', 'reviewAccepted', (item) => ({
    ...item,
    reviewAcceptedAt: ctx.now,
  }));
  if (ticket === TICKET_COUNT) {
    return { ...next, inbox: [...next.inbox, { id: ctx.id(), kind: 'completion', at: ctx.now, read: false }] };
  }
  return next;
}

export function markInboxRead(state: GameState, id: string): GameState {
  return { ...state, inbox: state.inbox.map((message) => (message.id === id ? { ...message, read: true } : message)) };
}
