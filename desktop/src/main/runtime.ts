/**
 * Everything the game needs from the outside world (Docker, the workspace, VS Code, QA),
 * behind one interface. DockerRuntime is the real one; test/e2e uses a fake (fake-runtime.ts).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Language, QaResult } from '../shared/types.ts';
import type { EnvironmentItem, EnvironmentReport } from '../shared/api.ts';
import type { Platform } from './platform/types.ts';
import type { ArchiveFile } from './services/content/archive.ts';
import { Docker, DockerUnavailableError } from './services/docker.ts';
import type { EngineState } from './services/docker.ts';
import { Prerequisites } from './services/prerequisites.ts';
import type { Environment } from './services/prerequisites.ts';
import type { PrerequisiteReport } from '../shared/api.ts';
import { QaRunner } from './services/qa.ts';
import { Workspace, resourceNames } from './services/workspace.ts';
import type { ResourceNames, WorkspacePorts } from './services/workspace.ts';

export type LineHandler = (line: string) => void;

export interface QaRequest {
  ticket: number;
  language: Language;
  timeoutSeconds: number;
  packageDir: string;
  onLine?: LineHandler;
}

export interface GameRuntime {
  checkPrerequisites(): Promise<PrerequisiteReport>;
  dockerState(): Promise<EngineState>;
  startDocker(onPoll?: (state: EngineState) => void): Promise<EngineState>;
  installDevContainers(): Promise<void>;

  environment(): Promise<EnvironmentReport>;
  /** Downloads and installs everything the environment report lists as missing. Needs internet. */
  installEnvironment(onLine: LineHandler): Promise<void>;

  /**
   * Makes the workspace repository belong to the game `gameId`, archiving player branches left by
   * another game. Returns the number of archived branches.
   */
  claimWorkspace(gameId: string): Promise<number>;
  importStage(stage: number, files: ArchiveFile[], message: string): Promise<string>;
  checkoutPlayerBranch(stage: number): Promise<void>;
  /** Discards everything on player/ticket-N and returns it to the clean stage commit. */
  resetToStage(stage: number): Promise<{ changes: number; commits: number }>;
  currentBranch(): Promise<string | null>;
  playerDiff(stage: number): Promise<string>;
  resetDatabase(): Promise<void>;
  hasRepository(): Promise<boolean>;

  workspacePorts(): Promise<WorkspacePorts | null>;
  isDevServerUp(): Promise<boolean>;
  startDevServer(): Promise<void>;
  openVSCode(): Promise<void>;

  runQa(request: QaRequest): Promise<QaResult>;
  cleanupQaLeftovers(): Promise<void>;

  bundle(): Promise<Uint8Array | null>;
  /** Replaces the workspace volume with the repository in `bundle`, checked out at `branch`. */
  restoreWorkspace(bundle: Uint8Array | null, branch: string | null, gameId?: string): Promise<void>;
}

export interface ImageConfig {
  /** Folder with workspace/, qa/ and images.json (build/docker in development, resources/docker when packaged). */
  contextRoot: string;
  /** Prefix of every Docker resource name (tests use their own). */
  prefix?: string;
}

interface ImageTags {
  workspace: string;
  qa: string;
}

export class DockerRuntime implements GameRuntime {
  private readonly platform: Platform;
  private readonly prerequisites: Prerequisites;
  private readonly contextRoot: string;
  readonly names: ResourceNames;
  private located: Environment | null = null;
  private tags: ImageTags | null = null;

  constructor(platform: Platform, images: ImageConfig) {
    this.platform = platform;
    this.prerequisites = new Prerequisites(platform);
    this.contextRoot = images.contextRoot;
    this.names = resourceNames(images.prefix);
  }

  private async env(refresh = false): Promise<Environment> {
    if (refresh || !this.located || !this.located.docker || !this.located.vscode) {
      this.located = await this.prerequisites.locate();
    }
    return this.located;
  }

  private async imageTags(): Promise<ImageTags> {
    this.tags ??= JSON.parse(await readFile(join(this.contextRoot, 'images.json'), 'utf8')) as ImageTags;
    return this.tags;
  }

  /** The docker CLI, if the engine is running. */
  private async docker(): Promise<Docker> {
    const env = await this.env();
    if (!env.docker || !(await env.docker.serverVersion())) {
      throw new DockerUnavailableError();
    }
    return env.docker;
  }

  private async workspace(): Promise<Workspace> {
    const docker = await this.docker();
    return new Workspace({
      docker,
      image: (await this.imageTags()).workspace,
      isPortFree: (port) => this.platform.isPortFree(port),
      names: this.names,
    });
  }

  /** The workspace, with its container running. */
  private async runningWorkspace(): Promise<Workspace> {
    const workspace = await this.workspace();
    await workspace.ensureRunning();
    return workspace;
  }

  private async qa(): Promise<QaRunner> {
    return new QaRunner({
      docker: await this.docker(),
      image: (await this.imageTags()).qa,
      dockerHostPath: (path) => this.platform.dockerHostPath(path),
      names: this.names,
    });
  }

  async checkPrerequisites() {
    return this.prerequisites.check(await this.env(true));
  }

  async dockerState() {
    return this.prerequisites.dockerState(await this.env());
  }

  async startDocker(onPoll?: (state: EngineState) => void) {
    return this.prerequisites.startDocker(await this.env(true), 180_000, onPoll);
  }

  async installDevContainers() {
    const { vscode } = await this.env(true);
    if (!vscode) {
      throw new Error('VS Code was not found');
    }
    await vscode.installDevContainers();
  }

  async environment(): Promise<EnvironmentReport> {
    const docker = await this.docker();
    const tags = await this.imageTags();
    const items: EnvironmentItem[] = [
      { id: 'workspaceImage', ready: await docker.imageExists(tags.workspace) },
      { id: 'qaImage', ready: await docker.imageExists(tags.qa) },
    ];
    if (items[0].ready && (await docker.volumeExists(this.names.volume))) {
      const workspace = await this.runningWorkspace();
      const key = (await workspace.hasRepository()) ? await workspace.dependencyKey() : null;
      if (key) {
        const ready = (await workspace.cachedDependencies(key)) && (await workspace.installedDependencyKey()) === key;
        items.push({ id: 'projectDependencies', ready });
      }
    }
    return { items, ready: items.every((item) => item.ready) };
  }

  async installEnvironment(onLine: LineHandler) {
    const docker = await this.docker();
    const tags = await this.imageTags();
    for (const [name, tag] of [
      ['workspace', tags.workspace],
      ['qa', tags.qa],
    ] as const) {
      if (!(await docker.imageExists(tag))) {
        onLine(`» docker build ${tag}`);
        await docker.build(this.platform.dockerHostPath(join(this.contextRoot, name)), tag, `${name}-image`, (line) => onLine(line));
      }
    }
    const workspace = await this.runningWorkspace();
    if (!(await workspace.hasRepository())) {
      return;
    }
    const key = await workspace.dependencyKey();
    if (!key) {
      return;
    }
    if (!(await workspace.cachedDependencies(key))) {
      onLine('» npm ci (QA dependency cache)');
      const branch = await workspace.currentBranch();
      const stage = Number(/^player\/ticket-(\d+)$/.exec(branch ?? '')?.[1] ?? 1);
      await (await this.qa()).prepareDependencies(stage, (line) => onLine(line));
    }
    if ((await workspace.installedDependencyKey()) !== key) {
      onLine('» Installing node_modules into the workspace');
      await workspace.installDependenciesFromCache(key, (line) => onLine(line));
      onLine('» npm run db:reset');
      await workspace.resetDatabase((line) => onLine(line));
    }
  }

  async claimWorkspace(gameId: string) {
    return (await this.runningWorkspace()).claimForGame(gameId);
  }

  async importStage(stage: number, files: ArchiveFile[], message: string) {
    return (await this.runningWorkspace()).importStage(stage, files, message);
  }

  async checkoutPlayerBranch(stage: number) {
    await (await this.runningWorkspace()).checkoutPlayerBranch(stage);
  }

  async resetToStage(stage: number) {
    return (await this.runningWorkspace()).resetToStage(stage);
  }

  async currentBranch() {
    return (await this.runningWorkspace()).currentBranch();
  }

  async playerDiff(stage: number) {
    return (await this.runningWorkspace()).playerDiff(stage);
  }

  async resetDatabase() {
    const workspace = await this.runningWorkspace();
    const key = await workspace.dependencyKey();
    if (key && (await workspace.installedDependencyKey()) === key) {
      await workspace.resetDatabase();
    }
  }

  async hasRepository() {
    return (await this.runningWorkspace()).hasRepository();
  }

  async workspacePorts() {
    return (await this.runningWorkspace()).ports();
  }

  async isDevServerUp() {
    return (await this.runningWorkspace()).isDevServerUp();
  }

  async startDevServer() {
    await (await this.runningWorkspace()).startDevServer();
  }

  async openVSCode() {
    const workspace = await this.runningWorkspace();
    const { vscode } = await this.env();
    if (!vscode) {
      throw new Error('VS Code was not found');
    }
    await vscode.openAttached(workspace.containerName);
  }

  async runQa(request: QaRequest) {
    await this.runningWorkspace();
    return (await this.qa()).run({ ...request, onLine: request.onLine && ((line) => request.onLine!(line)) });
  }

  async cleanupQaLeftovers() {
    await (await this.qa()).cleanupLeftovers();
  }

  async bundle() {
    const workspace = await this.workspace();
    if (!(await workspace.volumeExists())) {
      return null;
    }
    await workspace.ensureRunning();
    return (await workspace.hasRepository()) ? workspace.bundle() : null;
  }

  async restoreWorkspace(bundle: Uint8Array | null, branch: string | null, gameId?: string) {
    const workspace = await this.workspace();
    if (bundle) {
      // A bad bundle must fail here, while the current volume still exists.
      await workspace.ensureRunning();
      await workspace.verifyBundle(bundle);
    }
    await workspace.destroy();
    await workspace.ensureRunning();
    if (bundle && branch) {
      await workspace.restoreBundle(bundle, branch);
    }
    if (bundle && branch && gameId) {
      // The restored repository is this game's own work: mark it, archive nothing.
      await workspace.setGameId(gameId);
    }
  }
}
