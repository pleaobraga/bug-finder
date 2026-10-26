/**
 * Game state persistence: one versioned JSON file in the app data folder, written atomically
 * (temp file + rename), migrated forward on load and validated before use.
 */
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createInitialState } from '../../shared/kanban.ts';
import type { RuleContext } from '../../shared/kanban.ts';
import {
  COLUMNS,
  DEFAULT_QA_TIMEOUT_SECONDS,
  LANGUAGES,
  MAX_QA_TIMEOUT_SECONDS,
  MIN_QA_TIMEOUT_SECONDS,
  SCHEMA_VERSION,
  THEMES,
} from '../../shared/types.ts';
import type { GameState } from '../../shared/types.ts';
import { writeFileAtomic } from './content/store.ts';

const column = z.enum(COLUMNS);
const testRecord = z.object({
  name: z.string(),
  status: z.enum(['passed', 'failed', 'skipped', 'unfinished']),
  error: z.string().optional(),
});

export const gameStateSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  createdAt: z.string(),
  currentTicket: z.number().int().nullable(),
  tickets: z.array(
    z.object({
      ticket: z.number().int().min(1),
      status: column,
      unlockedAt: z.string(),
      stageCommit: z.string().nullable(),
      attempts: z.array(
        z.object({
          id: z.string(),
          number: z.number().int(),
          startedAt: z.string(),
          finishedAt: z.string(),
          branch: z.string().nullable(),
          branchWarning: z.boolean(),
          timeoutSeconds: z.number(),
          result: z.object({
            ticket: z.number().int(),
            gate: z.union([z.literal(1), z.literal(2)]),
            status: z.enum(['passed', 'failed', 'timeout']),
            message: z.string(),
            tests: z.array(testRecord),
            durationMs: z.number(),
          }),
        }),
      ),
      comments: z.array(
        z.object({
          id: z.string(),
          at: z.string(),
          kind: z.enum(['gate1Failed', 'gate2Failed', 'timeout', 'passed', 'interrupted', 'error', 'branchWarning']),
          attemptId: z.string().optional(),
          failing: z.array(z.object({ name: z.string(), error: z.string().optional() })).optional(),
          unfinished: z.array(z.string()).optional(),
          timeoutSeconds: z.number().optional(),
          detail: z.string().optional(),
          branch: z.string().nullable().optional(),
        }),
      ),
      hintsRevealed: z.number().int().min(0),
      solutionRevealed: z.boolean(),
      reviewAcceptedAt: z.string().nullable(),
      qaStartedAt: z.string().nullable(),
      playerDiff: z.string().nullable(),
      conversation: z.array(
        z.object({
          at: z.string(),
          from: z.enum(['player', 'senior']),
          kind: z.enum(['question', 'hint', 'solutionRequest', 'solution']),
          hintIndex: z.number().int().optional(),
        }),
      ),
    }),
  ),
  activity: z.array(
    z.object({
      ticket: z.number().int(),
      from: column.nullable(),
      to: column,
      at: z.string(),
      actor: z.enum(['player', 'system']),
      reason: z
        .enum(['unlocked', 'started', 'submitted', 'qaPassed', 'qaFailed', 'qaTimeout', 'qaInterrupted', 'qaError', 'reviewAccepted'])
        .optional(),
    }),
  ),
  inbox: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['welcome', 'assignment', 'completion']),
      ticket: z.number().int().optional(),
      at: z.string(),
      read: z.boolean(),
    }),
  ),
  settings: z.object({
    language: z.enum(LANGUAGES),
    qaTimeoutSeconds: z.number().int().min(MIN_QA_TIMEOUT_SECONDS).max(MAX_QA_TIMEOUT_SECONDS),
    theme: z.enum(THEMES),
  }),
});

// ---------------------------------------------------------------------------
// Migrations. Each one takes the raw JSON of version N and returns version N + 1.

type Raw = Record<string, any>;

/**
 * Version 1 (the first playtest build) stored `version`, `log`, `hintsUsed`, `solutionShown`
 * and a boolean `reviewAccepted`, and had no inbox, conversation, theme or QA timeout setting.
 */
function migrateV1toV2(v1: Raw, ctx: RuleContext): Raw {
  const log: Raw[] = Array.isArray(v1.log) ? v1.log : [];
  const tickets = (Array.isArray(v1.tickets) ? v1.tickets : []).map((ticket: Raw) => {
    const entries = log.filter((entry) => entry.ticket === ticket.ticket);
    const hints = Number(ticket.hintsUsed ?? 0);
    const conversation: Raw[] = [];
    for (let index = 0; index < hints; index += 1) {
      conversation.push({ at: ctx.now, from: 'player', kind: 'question' }, { at: ctx.now, from: 'senior', kind: 'hint', hintIndex: index });
    }
    if (ticket.solutionShown) {
      conversation.push({ at: ctx.now, from: 'player', kind: 'solutionRequest' }, { at: ctx.now, from: 'senior', kind: 'solution' });
    }
    return {
      ticket: ticket.ticket,
      status: ticket.status,
      unlockedAt: entries[0]?.at ?? ctx.now,
      stageCommit: ticket.stageCommit ?? null,
      attempts: ticket.attempts ?? [],
      comments: ticket.comments ?? [],
      hintsRevealed: hints,
      solutionRevealed: Boolean(ticket.solutionShown),
      reviewAcceptedAt: ticket.reviewAccepted ? (entries.find((entry) => entry.to === 'done')?.at ?? ctx.now) : null,
      qaStartedAt: ticket.status === 'inQa' ? ctx.now : null,
      playerDiff: null,
      conversation,
    };
  });
  const inbox: Raw[] = [{ id: ctx.id(), kind: 'welcome', at: v1.createdAt ?? ctx.now, read: true }];
  for (const ticket of tickets) {
    inbox.push({ id: ctx.id(), kind: 'assignment', ticket: ticket.ticket, at: ticket.unlockedAt, read: true });
  }
  return {
    schemaVersion: 2,
    createdAt: v1.createdAt ?? ctx.now,
    currentTicket: v1.currentTicket ?? null,
    tickets,
    activity: log.map((entry) => ({ ticket: entry.ticket, from: entry.from ?? null, to: entry.to, at: entry.at, actor: entry.actor ?? 'system' })),
    inbox,
    settings: {
      language: v1.settings?.language === 'pt' ? 'pt' : 'en',
      qaTimeoutSeconds: DEFAULT_QA_TIMEOUT_SECONDS,
      theme: 'system',
    },
  };
}

const MIGRATIONS: Record<number, (raw: Raw, ctx: RuleContext) => Raw> = {
  1: migrateV1toV2,
};

export class StateVersionError extends Error {}

/** Brings raw JSON of any known version up to the current schema and validates it. */
export function migrateState(raw: unknown, ctx: RuleContext): GameState {
  let state = raw as Raw;
  let version = Number(state?.schemaVersion ?? state?.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new StateVersionError('The saved game has no schema version');
  }
  if (version > SCHEMA_VERSION) {
    throw new StateVersionError(`The saved game was created by a newer version of Bug Detective (schema ${version})`);
  }
  while (version < SCHEMA_VERSION) {
    state = MIGRATIONS[version](state, ctx);
    version += 1;
  }
  return gameStateSchema.parse(state) as GameState;
}

export class StateStore {
  readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.file = join(dir, 'state.json');
  }

  /**
   * Loads the saved game, migrating it if needed. A missing file starts a new game; an
   * unreadable one is kept aside as state.corrupt-<time>.json and a new game starts.
   */
  async load(ctx: RuleContext, language: 'en' | 'pt' = 'en'): Promise<{ state: GameState; recovered: boolean }> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: createInitialState(ctx, language), recovered: false };
      }
      throw error;
    }
    try {
      const state = migrateState(JSON.parse(text), ctx);
      return { state, recovered: false };
    } catch (error) {
      if (error instanceof StateVersionError && /newer version/.test(error.message)) {
        throw error;
      }
      await rename(this.file, join(this.file, '..', `state.corrupt-${Date.now()}.json`));
      return { state: createInitialState(ctx, language), recovered: true };
    }
  }

  /** Saves atomically. Writes are serialized, so the last save always wins. */
  save(state: GameState): Promise<void> {
    const write = this.queue.then(() => writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`));
    this.queue = write.catch(() => {});
    return write;
  }
}
