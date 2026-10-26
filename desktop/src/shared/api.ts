/** The typed contract between the renderer and the main process (exposed by the preload script). */
import type { Column, GameState, Language, Settings } from './types.ts';

export type EngineState = 'notInstalled' | 'notRunning' | 'starting' | 'running';
export type CheckId = 'docker' | 'wsl' | 'vscode' | 'devcontainers';

export interface CheckResult {
  id: CheckId;
  status: 'ok' | 'missing' | 'warning' | 'pending';
  reason?: string;
  detail?: string;
}

export interface PrerequisiteReport {
  checks: CheckResult[];
  allOk: boolean;
  dockerState: EngineState;
}

export type EnvironmentItemId = 'workspaceImage' | 'qaImage' | 'projectDependencies';

export interface EnvironmentItem {
  id: EnvironmentItemId;
  ready: boolean;
}

export interface EnvironmentReport {
  items: EnvironmentItem[];
  ready: boolean;
}

export type BusyTask = 'unlocking' | 'starting' | 'installing' | 'qa' | 'exporting' | 'restoring' | 'startingDocker' | null;

export interface Snapshot {
  state: GameState;
  /** Ticket that "Get Next Assignment" would unlock, or null. */
  nextTicket: number | null;
  titles: Record<number, Record<Language, string>>;
  hintsTotal: Record<number, number>;
  busy: BusyTask;
  dockerState: EngineState | null;
  prerequisites: PrerequisiteReport | null;
  environment: EnvironmentReport | null;
  /** Output of the running install or QA, most recent last. */
  log: string[];
  contentSource: string;
  appVersion: string;
  versions: { electron: string; node: string; chrome: string };
}

export interface TicketContent {
  ticket: number;
  ticketMarkdown: string;
  hints: string[];
  hintsTotal: number;
  solutionMarkdown: string | null;
  reviewMarkdown: string | null;
  /** reference.patch: shown with the solution, and in Code Review. */
  referencePatch: string | null;
  playerDiff: string | null;
}

export interface WorkspaceStatus {
  ports: { client: number; api: number } | null;
  devServerUp: boolean;
  branch: string | null;
}

export interface ApiError {
  code: string;
  message: string;
}

export type Envelope<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface BugDetectiveApi {
  snapshot(): Promise<Snapshot>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;

  checkPrerequisites(): Promise<PrerequisiteReport>;
  startDocker(): Promise<EngineState>;
  installDevContainers(): Promise<PrerequisiteReport>;

  refreshEnvironment(): Promise<EnvironmentReport>;
  installEnvironment(): Promise<EnvironmentReport>;

  nextAssignment(): Promise<void>;
  move(ticket: number, to: Column): Promise<void>;
  askSenior(ticket: number): Promise<void>;
  revealSolution(ticket: number): Promise<void>;
  acceptReview(ticket: number): Promise<void>;
  markInboxRead(id: string): Promise<void>;

  ticketContent(ticket: number, language: Language): Promise<TicketContent>;
  workspaceStatus(): Promise<WorkspaceStatus>;
  openVSCode(): Promise<void>;
  openAppInBrowser(): Promise<void>;
  startDevServer(): Promise<void>;
  openExternal(link: ExternalLink): Promise<void>;

  updateSettings(settings: Partial<Settings>): Promise<void>;
  exportProgress(): Promise<{ saved: boolean; path?: string }>;
  /** Picks a save file and returns what it contains, so the player can confirm before overwriting. */
  inspectSave(): Promise<{ token: string; summary: SaveSummary } | null>;
  restoreProgress(token: string): Promise<void>;
  /** Starts over; the workspace's branches from this game are archived on the next unlock. */
  newGame(): Promise<void>;
}

export interface SaveSummary {
  fileName: string;
  createdAt: string;
  appVersion: string;
  ticketsDone: number;
  currentTicket: number | null;
  /** True when the current game has progress that the restore would overwrite. */
  overwritesProgress: boolean;
}

/** The only external pages the app opens (besides the workspace app on 127.0.0.1). */
export const EXTERNAL_LINKS = {
  dockerDesktop: 'https://docs.docker.com/desktop/setup/install/windows-install/',
  wsl: 'https://learn.microsoft.com/windows/wsl/install',
  vscode: 'https://code.visualstudio.com/download',
  devContainers: 'https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers',
} as const;

export type ExternalLink = keyof typeof EXTERNAL_LINKS;
