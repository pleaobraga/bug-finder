/** The first-run checklist: Docker Desktop, WSL2, VS Code and the Dev Containers extension. */
import type { CheckResult, EngineState, PrerequisiteReport } from '../../shared/api.ts';
import type { Platform, VSCodeCli } from '../platform/types.ts';
import { Docker } from './docker.ts';
import { VSCode } from './vscode.ts';

export interface Environment {
  docker: Docker | null;
  dockerDesktopApp: string | null;
  vscode: VSCode | null;
  vscodeCli: VSCodeCli | null;
}

export class Prerequisites {
  private readonly platform: Platform;

  constructor(platform: Platform) {
    this.platform = platform;
  }

  async locate(): Promise<Environment> {
    const docker = await this.platform.locateDocker();
    const vscodeCli = await this.platform.locateVSCode();
    return {
      docker: docker.cli ? new Docker(docker.cli, this.platform.runner) : null,
      dockerDesktopApp: docker.desktopApp,
      vscode: vscodeCli ? new VSCode(vscodeCli, this.platform.runner) : null,
      vscodeCli,
    };
  }

  /** Distinguishes not installed, installed but stopped, starting and running. */
  async dockerState(environment: Environment): Promise<EngineState> {
    if (!environment.docker) {
      return environment.dockerDesktopApp ? 'notRunning' : 'notInstalled';
    }
    if (await environment.docker.serverVersion()) {
      return 'running';
    }
    if (!environment.dockerDesktopApp) {
      // Docker Engine (Linux): the CLI is there but the daemon does not answer.
      return 'notRunning';
    }
    return (await this.platform.isDockerDesktopRunning()) ? 'starting' : 'notRunning';
  }

  async check(environment?: Environment): Promise<PrerequisiteReport> {
    const env = environment ?? (await this.locate());
    const [dockerState, wsl, devcontainers] = await Promise.all([
      this.dockerState(env),
      this.platform.checkWsl().catch((error: Error) => ({ installed: false, version2: false, detail: error.message })),
      env.vscode?.hasDevContainers().catch(() => null) ?? Promise.resolve(null),
    ]);
    const checks: CheckResult[] = [
      dockerState === 'running'
        ? { id: 'docker', status: 'ok' }
        : { id: 'docker', status: dockerState === 'starting' ? 'pending' : 'missing', reason: dockerState },
      !wsl.installed
        ? { id: 'wsl', status: 'missing', reason: 'notFound', detail: wsl.detail }
        : wsl.version2
          ? { id: 'wsl', status: 'ok', detail: wsl.detail }
          : { id: 'wsl', status: 'missing', reason: 'wsl1Only', detail: wsl.detail },
      env.vscodeCli
        ? { id: 'vscode', status: 'ok', detail: env.vscodeCli.launcher }
        : { id: 'vscode', status: 'missing', reason: 'cliNotFound' },
      devcontainers === true
        ? { id: 'devcontainers', status: 'ok' }
        : {
            id: 'devcontainers',
            status: 'missing',
            reason: devcontainers === null && env.vscode ? 'checkFailed' : 'extensionMissing',
          },
    ];
    return { checks, allOk: checks.every((check) => check.status === 'ok'), dockerState };
  }

  /** Starts Docker Desktop and polls until the engine answers, or the timeout passes. */
  async startDocker(environment: Environment, timeoutMs = 180_000, onPoll?: (state: EngineState) => void): Promise<EngineState> {
    if (!environment.dockerDesktopApp) {
      return 'notInstalled';
    }
    if ((await this.dockerState(environment)) === 'running') {
      return 'running';
    }
    await this.platform.startDockerDesktop(environment.dockerDesktopApp);
    const deadline = Date.now() + timeoutMs;
    let located = environment;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      // The CLI may only appear on PATH after the first start.
      if (!located.docker) {
        located = { ...located, ...(await this.locate()) };
      }
      const state = await this.dockerState(located);
      onPoll?.(state);
      if (state === 'running') {
        return state;
      }
    }
    return this.dockerState(located);
  }
}
