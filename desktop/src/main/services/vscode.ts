/**
 * Opens VS Code attached to the workspace container (Dev Containers "Attach to Running Container"),
 * and manages the Dev Containers extension. Arguments are fixed; nothing comes from user input.
 */
import type { VSCodeCli } from '../platform/types.ts';
import type { CommandRunner, RunResult } from './process.ts';
import { WORKSPACE_DIR } from './workspace.ts';

export const DEV_CONTAINERS_EXTENSION = 'ms-vscode-remote.remote-containers';

/**
 * vscode-remote://attached-container+<hex of {"containerName":"/<name>"}><folder>.
 * The container name is validated, so the URI can only point at our own container.
 */
export function attachedContainerUri(containerName: string, folder = WORKSPACE_DIR): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerName)) {
    throw new Error(`Invalid container name: ${containerName}`);
  }
  const hex = Buffer.from(JSON.stringify({ containerName: `/${containerName}` }), 'utf8').toString('hex');
  return `vscode-remote://attached-container+${hex}${folder}`;
}

export class VSCode {
  private readonly cli: VSCodeCli;
  private readonly runner: CommandRunner;

  constructor(cli: VSCodeCli, runner: CommandRunner) {
    this.cli = cli;
    this.runner = runner;
  }

  private run(args: string[], timeoutMs = 120_000): Promise<RunResult> {
    return this.runner(this.cli.command, [...this.cli.baseArgs, ...args], { env: this.cli.env, timeoutMs });
  }

  async version(): Promise<string | null> {
    const result = await this.run(['--version'], 30_000);
    return result.code === 0 ? (result.stdout.toString('utf8').split(/\r?\n/)[0] ?? null) : null;
  }

  async listExtensions(): Promise<string[]> {
    const result = await this.run(['--list-extensions'], 60_000);
    if (result.code !== 0) {
      throw new Error(`code --list-extensions failed: ${result.stderr.trim()}`);
    }
    return result.stdout.toString('utf8').split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean);
  }

  async hasDevContainers(): Promise<boolean> {
    return (await this.listExtensions()).includes(DEV_CONTAINERS_EXTENSION);
  }

  async installDevContainers(): Promise<void> {
    const result = await this.run(['--install-extension', DEV_CONTAINERS_EXTENSION], 5 * 60_000);
    if (result.code !== 0) {
      throw new Error(`Installing the Dev Containers extension failed: ${(result.stderr || result.stdout.toString('utf8')).trim()}`);
    }
  }

  /** Opens a new VS Code window attached to the container, at the workspace folder. */
  async openAttached(containerName: string): Promise<void> {
    const result = await this.run(['--new-window', '--folder-uri', attachedContainerUri(containerName)], 60_000);
    if (result.code !== 0) {
      throw new Error(`VS Code could not be opened: ${(result.stderr || result.stdout.toString('utf8')).trim()}`);
    }
  }
}
