/** Types shared by the main process, the preload bridge and the renderer. */

export const TICKET_COUNT = 4;
export const HINTS_PER_TICKET = 3;
export const DEFAULT_QA_TIMEOUT_SECONDS = 180;
export const MIN_QA_TIMEOUT_SECONDS = 30;
export const MAX_QA_TIMEOUT_SECONDS = 1800;

export const COLUMNS = ['todo', 'inProgress', 'inQa', 'codeReview', 'done'] as const;
export type Column = (typeof COLUMNS)[number];

export const LANGUAGES = ['en', 'pt'] as const;
export type Language = (typeof LANGUAGES)[number];

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

// ---------------------------------------------------------------------------
// QA results, as written by the SupportDesk QA CLI with --json

export type QaTestStatus = 'passed' | 'failed' | 'skipped' | 'unfinished';

export interface QaTestRecord {
  name: string;
  status: QaTestStatus;
  error?: string;
}

export interface QaResult {
  ticket: number;
  gate: 1 | 2;
  status: 'passed' | 'failed' | 'timeout';
  message: string;
  tests: QaTestRecord[];
  durationMs: number;
}

export interface QaAttempt {
  id: string;
  /** 1-based attempt number for this ticket. Interrupted runs and infrastructure errors are not attempts. */
  number: number;
  startedAt: string;
  finishedAt: string;
  /** Branch checked out in the workspace when QA started, or null for a detached HEAD. */
  branch: string | null;
  branchWarning: boolean;
  timeoutSeconds: number;
  result: QaResult;
}

export type QaCommentKind =
  | 'gate1Failed'
  | 'gate2Failed'
  | 'timeout'
  | 'passed'
  | 'interrupted'
  | 'error'
  | 'branchWarning';

/** A QA comment is stored as data and rendered with the templates of the current language. */
export interface QaComment {
  id: string;
  at: string;
  kind: QaCommentKind;
  attemptId?: string;
  failing?: { name: string; error?: string }[];
  unfinished?: string[];
  timeoutSeconds?: number;
  /** Technical detail for an infrastructure error (not translated). */
  detail?: string;
  /** For branch warnings: the branch that was checked out instead. */
  branch?: string | null;
}

export type ChatKind = 'question' | 'hint' | 'solutionRequest' | 'solution';

export interface ChatEntry {
  at: string;
  from: 'player' | 'senior';
  kind: ChatKind;
  /** 0-based hint index for kind "hint". */
  hintIndex?: number;
}

export interface TicketState {
  ticket: number;
  status: Column;
  unlockedAt: string;
  /** Commit of the imported stage snapshot in the workspace repository. */
  stageCommit: string | null;
  attempts: QaAttempt[];
  comments: QaComment[];
  hintsRevealed: number;
  solutionRevealed: boolean;
  reviewAcceptedAt: string | null;
  /** Set while QA is running, so an interrupted run can be detected on the next start. */
  qaStartedAt: string | null;
  /** The player's diff against the stage commit, captured when QA passed. */
  playerDiff: string | null;
  conversation: ChatEntry[];
}

export interface ActivityEntry {
  ticket: number;
  from: Column | null;
  to: Column;
  at: string;
  actor: 'player' | 'system';
  reason?: 'unlocked' | 'started' | 'submitted' | 'qaPassed' | 'qaFailed' | 'qaTimeout' | 'qaInterrupted' | 'qaError' | 'reviewAccepted';
}

export type InboxKind = 'welcome' | 'assignment' | 'completion';

export interface InboxMessage {
  id: string;
  kind: InboxKind;
  ticket?: number;
  at: string;
  read: boolean;
}

export interface Settings {
  language: Language;
  qaTimeoutSeconds: number;
  theme: Theme;
}

export const SCHEMA_VERSION = 2;

export interface GameState {
  schemaVersion: typeof SCHEMA_VERSION;
  createdAt: string;
  /** The active ticket (the last unlocked one), or null before the first assignment. */
  currentTicket: number | null;
  tickets: TicketState[];
  /** Append-only. */
  activity: ActivityEntry[];
  inbox: InboxMessage[];
  settings: Settings;
}
