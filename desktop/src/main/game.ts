/**
 * The game controller: applies the Kanban rules to the saved state and drives the runtime.
 * Independent of Electron, so it can be tested with plain Node.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { BusyTask, EngineState, EnvironmentReport, PrerequisiteReport, SaveSummary, Snapshot, TicketContent } from '../shared/api.ts';
import * as rules from '../shared/kanban.ts';
import type { RuleContext } from '../shared/kanban.ts';
import { HINTS_PER_TICKET, LANGUAGES, MAX_QA_TIMEOUT_SECONDS, MIN_QA_TIMEOUT_SECONDS } from '../shared/types.ts';
import type { Column, GameState, Language, Settings } from '../shared/types.ts';
import type { GameRuntime } from './runtime.ts';
import { createSave, readSave } from './services/backup.ts';
import type { ValidatedSave } from './services/backup.ts';
import type { ContentSource } from './services/content/source.ts';
import type { PackageStore } from './services/content/store.ts';
import { writeFileAtomic } from './services/content/store.ts';
import { DockerUnavailableError } from './services/docker.ts';
import type { StateStore } from './services/state.ts';
import { playerBranch } from './services/workspace.ts';

export class GameError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export interface GameOptions {
  store: StateStore;
  packages: PackageStore;
  content: ContentSource;
  runtime: GameRuntime;
  appVersion: string;
  versions: Snapshot['versions'];
  /** Called after every change, with the new snapshot. */
  onChange?: (snapshot: Snapshot) => void;
  clock?: () => Date;
}

const LOG_LINES = 300;

export class Game {
  private state!: GameState;
  private readonly options: GameOptions;
  private busy: BusyTask = null;
  private dockerState: EngineState | null = null;
  private prerequisites: PrerequisiteReport | null = null;
  private environment: EnvironmentReport | null = null;
  private log: string[] = [];
  private titles: Snapshot['titles'] = {};
  private hintsTotal: Record<number, number> = {};
  private qaRun: Promise<void> | null = null;
  private pendingSaves = new Map<string, ValidatedSave & { fileName: string }>();

  constructor(options: GameOptions) {
    this.options = options;
  }

  private ctx(): RuleContext {
    return { now: (this.options.clock?.() ?? new Date()).toISOString(), id: () => randomUUID() };
  }

  /** Loads the saved game and recovers a QA run interrupted by a crash or a closed app. */
  async init(language: Language = 'en'): Promise<void> {
    const { state } = await this.options.store.load(this.ctx(), language);
    const recovered = rules.recoverInterruptedQa(state, this.ctx());
    this.state = recovered;
    if (recovered !== state) {
      await this.options.store.save(recovered);
    }
    await this.loadTicketMeta();
  }

  get current(): GameState {
    return this.state;
  }

  snapshot(): Snapshot {
    return {
      state: this.state,
      nextTicket: rules.nextTicketNumber(this.state),
      titles: this.titles,
      hintsTotal: this.hintsTotal,
      busy: this.busy,
      dockerState: this.dockerState,
      prerequisites: this.prerequisites,
      environment: this.environment,
      log: this.log,
      contentSource: `${this.options.content.kind}: ${this.options.content.describe()}`,
      appVersion: this.options.appVersion,
      versions: this.options.versions,
    };
  }

  private emit(): void {
    this.options.onChange?.(this.snapshot());
  }

  private appendLog(line: string): void {
    this.log = [...this.log, line].slice(-LOG_LINES);
    this.emit();
  }

  private async commit(next: GameState): Promise<void> {
    await this.options.store.save(next);
    this.state = next;
    this.emit();
  }

  /** Applies a rule; GameRuleErrors become GameErrors with the same code. */
  private apply(change: (state: GameState, ctx: RuleContext) => GameState): GameState {
    try {
      return change(this.state, this.ctx());
    } catch (error) {
      if (error instanceof rules.GameRuleError) {
        throw new GameError(error.code, error.message);
      }
      throw error;
    }
  }

  private async exclusive<T>(task: Exclude<BusyTask, null>, action: () => Promise<T>): Promise<T> {
    if (this.busy) {
      throw new GameError('busy', `Busy: ${this.busy}`);
    }
    this.busy = task;
    this.log = [];
    this.emit();
    try {
      return await action();
    } finally {
      this.busy = null;
      this.emit();
    }
  }

  private async loadTicketMeta(): Promise<void> {
    for (const ticket of this.state.tickets) {
      const titles = {} as Record<Language, string>;
      for (const language of LANGUAGES) {
        const markdown = (await this.options.packages.readText(ticket.ticket, `ticket.${language}.md`)) ?? '';
        titles[language] = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? `Ticket ${ticket.ticket}`;
      }
      this.titles[ticket.ticket] = titles;
      const hints = await this.options.packages.readText(ticket.ticket, 'hints.en.json');
      this.hintsTotal[ticket.ticket] = hints ? (JSON.parse(hints) as { hints: string[] }).hints.length : HINTS_PER_TICKET;
    }
  }

  // -------------------------------------------------------------------------
  // Docker and prerequisites

  setDockerState(state: EngineState): void {
    if (state !== this.dockerState) {
      this.dockerState = state;
      this.emit();
    }
  }

  async refreshDockerState(): Promise<EngineState> {
    const state = await this.options.runtime.dockerState().catch((): EngineState => 'notRunning');
    this.setDockerState(state);
    return state;
  }

  private async requireDocker(): Promise<void> {
    if ((await this.refreshDockerState()) !== 'running') {
      throw new GameError('dockerUnavailable', 'Docker is not running');
    }
  }

  /** Removes QA containers left behind by a crash or a closed app. */
  async cleanupLeftovers(): Promise<void> {
    if ((await this.refreshDockerState()) === 'running') {
      await this.options.runtime.cleanupQaLeftovers().catch(() => {});
    }
  }

  async checkPrerequisites(): Promise<PrerequisiteReport> {
    this.prerequisites = await this.options.runtime.checkPrerequisites();
    this.dockerState = this.prerequisites.dockerState;
    this.emit();
    return this.prerequisites;
  }

  async startDocker(): Promise<EngineState> {
    return this.exclusive('startingDocker', async () => {
      const state = await this.options.runtime.startDocker((polled) => this.setDockerState(polled));
      this.setDockerState(state);
      await this.checkPrerequisites();
      return state;
    });
  }

  async installDevContainers(): Promise<PrerequisiteReport> {
    await this.options.runtime.installDevContainers();
    return this.checkPrerequisites();
  }

  async refreshEnvironment(): Promise<EnvironmentReport> {
    await this.requireDocker();
    this.environment = await this.options.runtime.environment();
    this.emit();
    return this.environment;
  }

  async installEnvironment(): Promise<EnvironmentReport> {
    await this.requireDocker();
    await this.exclusive('installing', () => this.options.runtime.installEnvironment((line) => this.appendLog(line)));
    return this.refreshEnvironment();
  }

  // -------------------------------------------------------------------------
  // Assignments

  /**
   * Unlocks the next stage. Download and verification happen first; the workspace is only
   * touched once everything is verified, so a failed download can simply be retried.
   */
  async nextAssignment(): Promise<void> {
    const ticket = rules.nextTicketNumber(this.state);
    if (ticket === null) {
      this.apply((state) => {
        rules.assertCanUnlock(state, state.tickets.length + 1);
        return state;
      });
      throw new GameError('noMoreTickets');
    }
    await this.requireDocker();
    await this.exclusive('unlocking', async () => {
      this.appendLog(`» Fetching stage ${ticket} from ${this.options.content.describe()}`);
      const fetched = await this.options.content.fetchStage(ticket);
      this.appendLog(`» Verified ${fetched.codeFiles.length} files and the stage package (SHA-256)`);
      await this.options.packages.save(ticket, fetched.packageZip);
      const commit = await this.options.runtime.importStage(ticket, fetched.codeFiles, fetched.entry.commitMessage);
      this.appendLog(`» Imported as commit ${commit.slice(0, 12)}`);
      await this.options.runtime.checkoutPlayerBranch(ticket);
      this.appendLog(`» Checked out ${playerBranch(ticket)}`);
      await this.options.runtime.resetDatabase().catch(() => {});
      await this.commit(this.apply((state, ctx) => rules.unlockTicket(state, ticket, commit, ctx)));
      await this.loadTicketMeta();
    });
    await this.refreshEnvironment().catch(() => {});
  }

  async move(ticket: number, to: Column): Promise<void> {
    if (to === 'inQa') {
      return this.submitToQa(ticket);
    }
    await this.commit(this.apply((state, ctx) => rules.playerMove(state, ticket, to, ctx)));
  }

  /** Moving to In QA: checks the environment, moves the card and runs QA in the background. */
  private async submitToQa(ticket: number): Promise<void> {
    // Validate the move before any slow check, so forbidden moves fail fast.
    this.apply((state, ctx) => rules.playerMove(state, ticket, 'inQa', ctx));
    if (this.busy) {
      throw new GameError('busy', `Busy: ${this.busy}`);
    }
    await this.requireDocker();
    const environment = await this.refreshEnvironment();
    if (!environment.ready) {
      throw new GameError('environmentNotReady');
    }
    const startedAt = this.ctx().now;
    await this.commit(this.apply((state, ctx) => rules.playerMove(state, ticket, 'inQa', ctx)));
    this.busy = 'qa';
    this.log = [];
    this.emit();
    this.qaRun = this.runQa(ticket, startedAt).finally(() => {
      this.busy = null;
      this.qaRun = null;
      this.emit();
    });
  }

  /** Resolves when the QA run started by the last move to In QA has finished (for tests). */
  async waitForQa(): Promise<void> {
    await this.qaRun;
  }

  private async runQa(ticket: number, startedAt: string): Promise<void> {
    const { runtime, packages } = this.options;
    const timeoutSeconds = this.state.settings.qaTimeoutSeconds;
    try {
      const branch = await runtime.currentBranch();
      const branchWarning = branch !== playerBranch(ticket);
      if (branchWarning) {
        await this.commit(this.apply((state, ctx) => rules.addBranchWarning(state, ticket, branch, ctx)));
      }
      const result = await runtime.runQa({
        ticket,
        language: this.state.settings.language,
        timeoutSeconds,
        packageDir: packages.dir(ticket),
        onLine: (line) => this.appendLog(line),
      });
      const playerDiff = result.status === 'passed' ? await runtime.playerDiff(ticket).catch(() => null) : null;
      await this.commit(
        this.apply((state, ctx) => rules.recordQaResult(state, ticket, { startedAt, branch, branchWarning, timeoutSeconds, result, playerDiff }, ctx)),
      );
    } catch (error) {
      const detail = error instanceof DockerUnavailableError ? 'Docker stopped while QA was running.' : (error as Error).message;
      await this.commit(this.apply((state, ctx) => rules.recordQaError(state, ticket, detail.slice(0, 4000), ctx)));
      await this.refreshDockerState();
    }
  }

  async askSenior(ticket: number): Promise<void> {
    await this.commit(this.apply((state, ctx) => rules.revealHint(state, ticket, this.hintsTotal[ticket] ?? HINTS_PER_TICKET, ctx)));
  }

  async revealSolution(ticket: number): Promise<void> {
    await this.commit(this.apply((state, ctx) => rules.revealSolution(state, ticket, this.hintsTotal[ticket] ?? HINTS_PER_TICKET, ctx)));
  }

  async acceptReview(ticket: number): Promise<void> {
    await this.commit(this.apply((state, ctx) => rules.acceptReview(state, ticket, ctx)));
  }

  async markInboxRead(id: string): Promise<void> {
    await this.commit(rules.markInboxRead(this.state, id));
  }

  async updateSettings(settings: Partial<Settings>): Promise<void> {
    const next = { ...this.state.settings, ...settings };
    next.qaTimeoutSeconds = Math.min(MAX_QA_TIMEOUT_SECONDS, Math.max(MIN_QA_TIMEOUT_SECONDS, Math.round(next.qaTimeoutSeconds)));
    await this.commit({ ...this.state, settings: next });
  }

  /** Ticket texts and what the player has unlocked so far: hints, solution, review. */
  async ticketContent(ticket: number, language: Language): Promise<TicketContent> {
    const current = rules.findTicket(this.state, ticket);
    if (!current) {
      throw new GameError('noSuchTicket');
    }
    const read = (file: string) => this.options.packages.readText(ticket, file);
    const hintsJson = await read(`hints.${language}.json`);
    const allHints = hintsJson ? (JSON.parse(hintsJson) as { hints: string[] }).hints : [];
    const inReview = current.status === 'codeReview' || current.status === 'done';
    const showReference = inReview || current.solutionRevealed;
    return {
      ticket,
      ticketMarkdown: (await read(`ticket.${language}.md`)) ?? '',
      hints: allHints.slice(0, current.hintsRevealed),
      hintsTotal: allHints.length,
      solutionMarkdown: current.solutionRevealed ? await read(`solution.${language}.md`) : null,
      reviewMarkdown: inReview ? await read(`review.${language}.md`) : null,
      referencePatch: showReference ? await read('reference.patch') : null,
      playerDiff: current.playerDiff,
    };
  }

  async workspaceStatus() {
    await this.requireDocker();
    const { runtime } = this.options;
    const [ports, devServerUp, branch] = await Promise.all([
      runtime.workspacePorts(),
      runtime.isDevServerUp(),
      runtime.currentBranch().catch(() => null),
    ]);
    return { ports, devServerUp, branch };
  }

  async openVSCode(): Promise<void> {
    await this.requireDocker();
    await this.options.runtime.openVSCode();
  }

  async startDevServer(): Promise<void> {
    await this.requireDocker();
    await this.options.runtime.startDevServer();
  }

  /** The URL of the player's app on the published port. */
  async appUrl(): Promise<string> {
    await this.requireDocker();
    const ports = await this.options.runtime.workspacePorts();
    if (!ports?.client) {
      throw new GameError('workspaceNotRunning');
    }
    return `http://127.0.0.1:${ports.client}/`;
  }

  // -------------------------------------------------------------------------
  // Export and restore

  async exportProgress(file: string): Promise<void> {
    await this.requireDocker();
    await this.exclusive('exporting', async () => {
      const packages = new Map<number, Uint8Array>();
      for (const ticket of this.state.tickets) {
        packages.set(ticket.ticket, await this.options.packages.readZip(ticket.ticket));
      }
      const bundle = await this.options.runtime.bundle();
      const save = createSave({ state: this.state, bundle, packages }, this.options.appVersion, this.ctx().now);
      await writeFileAtomic(file, save);
    });
  }

  /** Validates a save file and keeps it for restoreProgress, returning a summary to confirm. */
  async inspectSave(file: string, fileName: string): Promise<{ token: string; summary: SaveSummary }> {
    let validated: ValidatedSave;
    try {
      validated = readSave(new Uint8Array(await readFile(file)), this.ctx());
    } catch (error) {
      throw new GameError('invalidSave', (error as Error).message);
    }
    const token = randomUUID();
    this.pendingSaves.set(token, { ...validated, fileName });
    return {
      token,
      summary: {
        fileName,
        createdAt: validated.manifest.createdAt,
        appVersion: validated.manifest.appVersion,
        ticketsDone: validated.state.tickets.filter((ticket) => ticket.status === 'done').length,
        currentTicket: validated.state.currentTicket,
        overwritesProgress: this.state.tickets.length > 0,
      },
    };
  }

  /** Recreates the volume and repository from the bundle, then restores packages and state. */
  async restoreProgress(token: string): Promise<void> {
    const save = this.pendingSaves.get(token);
    if (!save) {
      throw new GameError('invalidSave', 'Choose the save file again');
    }
    if (this.qaRun) {
      throw new GameError('busy');
    }
    await this.requireDocker();
    await this.exclusive('restoring', async () => {
      this.pendingSaves.delete(token);
      const current = save.state.currentTicket;
      this.appendLog('» Recreating the workspace volume from the save');
      await this.options.runtime.restoreWorkspace(save.bundle, current === null ? null : playerBranch(current));
      await this.options.packages.clear();
      for (const [stage, zip] of save.packages) {
        await this.options.packages.save(stage, zip);
      }
      // A save taken during QA restores as interrupted, like after a crash.
      await this.commit(rules.recoverInterruptedQa(save.state, this.ctx()));
      this.titles = {};
      await this.loadTicketMeta();
    });
    await this.refreshEnvironment().catch(() => {});
  }
}
