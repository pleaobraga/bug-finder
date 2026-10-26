/**
 * In-memory runtime for the Electron end-to-end tests (BUGDETECTIVE_E2E=1, development builds
 * only). Prerequisites and QA outcomes come from a JSON scenario; content still comes from the
 * real content source, so tickets, hints and reviews are the real ones.
 */
import { createHash } from 'node:crypto';
import type { EngineState, EnvironmentReport, PrerequisiteReport } from '../shared/api.ts';
import type { QaResult } from '../shared/types.ts';
import type { GameRuntime, LineHandler, QaRequest } from './runtime.ts';
import type { ArchiveFile } from './services/content/archive.ts';

type QaOutcome = 'passed' | 'gate1' | 'gate2' | 'timeout' | 'error';

interface Scenario {
  docker: EngineState;
  wsl: boolean;
  vscode: boolean;
  devcontainers: boolean;
  environmentReady: boolean;
  qa: QaOutcome[];
  qaDelayMs: number;
  branch: string | null;
  /** Simulates Docker stopping in the middle of a session, right after the first unlock. */
  stopDockerAfterUnlock: boolean;
}

const DEFAULT_SCENARIO: Scenario = {
  docker: 'running',
  wsl: true,
  vscode: true,
  devcontainers: true,
  environmentReady: true,
  qa: ['gate2', 'passed'],
  qaDelayMs: 300,
  branch: null,
  stopDockerAfterUnlock: false,
};

export class FakeRuntime implements GameRuntime {
  private readonly scenario: Scenario;
  private qaIndex = 0;
  private branch: string | null = null;
  private stages = new Map<number, string>();

  constructor(json?: string) {
    this.scenario = { ...DEFAULT_SCENARIO, ...(json ? (JSON.parse(json) as Partial<Scenario>) : {}) };
  }

  async checkPrerequisites(): Promise<PrerequisiteReport> {
    const { docker, wsl, vscode, devcontainers } = this.scenario;
    const checks: PrerequisiteReport['checks'] = [
      docker === 'running' ? { id: 'docker', status: 'ok' } : { id: 'docker', status: 'missing', reason: docker },
      wsl ? { id: 'wsl', status: 'ok', detail: 'docker-desktop (WSL 2)' } : { id: 'wsl', status: 'missing', reason: 'notFound' },
      vscode ? { id: 'vscode', status: 'ok' } : { id: 'vscode', status: 'missing', reason: 'cliNotFound' },
      devcontainers && vscode
        ? { id: 'devcontainers', status: 'ok' }
        : { id: 'devcontainers', status: 'missing', reason: 'extensionMissing' },
    ];
    return { checks, allOk: checks.every((check) => check.status === 'ok'), dockerState: docker };
  }

  async dockerState() {
    return this.scenario.docker;
  }

  async startDocker(onPoll?: (state: EngineState) => void) {
    onPoll?.('starting');
    await new Promise((resolve) => setTimeout(resolve, 200));
    this.scenario.docker = 'running';
    return this.scenario.docker;
  }

  async installDevContainers() {
    if (!this.scenario.vscode) {
      throw new Error('VS Code was not found');
    }
    this.scenario.devcontainers = true;
  }

  async environment(): Promise<EnvironmentReport> {
    const ready = this.scenario.environmentReady;
    return {
      items: [
        { id: 'workspaceImage', ready },
        { id: 'qaImage', ready },
      ],
      ready,
    };
  }

  async installEnvironment(onLine: LineHandler) {
    onLine('» docker build bugdetective-workspace (fake)');
    onLine('» docker build bugdetective-qa (fake)');
    this.scenario.environmentReady = true;
  }

  async importStage(stage: number, files: ArchiveFile[]) {
    const commit = createHash('sha1').update(`stage-${stage}:${files.length}`).digest('hex');
    this.stages.set(stage, commit);
    return commit;
  }

  async checkoutPlayerBranch(stage: number) {
    this.branch = `player/ticket-${stage}`;
    if (this.scenario.stopDockerAfterUnlock) {
      setTimeout(() => {
        this.scenario.docker = 'notRunning';
      }, 500);
    }
  }

  async currentBranch() {
    return this.scenario.branch ?? this.branch;
  }

  async playerDiff(stage: number) {
    return `diff --git a/client/src/pages/TicketDetails.tsx b/client/src/pages/TicketDetails.tsx\n--- a/client/src/pages/TicketDetails.tsx\n+++ b/client/src/pages/TicketDetails.tsx\n@@ -1 +1 @@\n-// stage ${stage}\n+// fixed by the player\n`;
  }

  async resetDatabase() {}

  async hasRepository() {
    return this.stages.size > 0;
  }

  async workspacePorts() {
    return { client: 5173, api: 3001 };
  }

  async isDevServerUp() {
    return false;
  }

  async startDevServer() {}

  async openVSCode() {}

  async runQa(request: QaRequest): Promise<QaResult> {
    const outcome = this.scenario.qa[Math.min(this.qaIndex, this.scenario.qa.length - 1)];
    this.qaIndex += 1;
    request.onLine?.('Bug Detective QA (fake)');
    await new Promise((resolve) => setTimeout(resolve, this.scenario.qaDelayMs));
    const base = { ticket: request.ticket, message: '', durationMs: this.scenario.qaDelayMs };
    switch (outcome) {
      case 'passed':
        return { ...base, gate: 2, status: 'passed', tests: [{ name: 'Ticket validation', status: 'passed' }] };
      case 'gate1':
        return {
          ...base,
          gate: 1,
          status: 'failed',
          tests: [{ name: 'client/src/pages/TicketList.test.tsx > TicketList > renders', status: 'failed', error: 'expected 15 rows, got 0' }],
        };
      case 'timeout':
        return { ...base, gate: 2, status: 'timeout', tests: [{ name: 'Ticket validation > slow test', status: 'unfinished' }] };
      case 'error':
        throw new Error('Simulated infrastructure error');
      default:
        return {
          ...base,
          gate: 2,
          status: 'failed',
          tests: [
            { name: 'Gate 1 > project tests', status: 'passed' },
            { name: 'Ticket validation > Next shows the next ticket', status: 'failed', error: 'Expected "4", received "3"' },
          ],
        };
    }
  }

  async cleanupQaLeftovers() {}

  async bundle() {
    return null;
  }

  async restoreWorkspace() {}
}
