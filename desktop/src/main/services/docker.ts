/**
 * Thin wrapper around the docker CLI. Every call is an argument array; resources created by the
 * app carry the `bugdetective.role` label so cleanup never touches anything else.
 */
import type { Readable } from 'node:stream';
import { CommandError, runChecked } from './process.ts';
import type { CommandRunner, RunOptions, RunResult } from './process.ts';

export const LABEL = 'bugdetective.role';

export type { EngineState } from '../../shared/api.ts';

export interface ContainerInfo {
  name: string;
  running: boolean;
  image: string;
  /** Published host ports by container port, for example { 15173: 5173 }. */
  ports: Record<number, number>;
  labels: Record<string, string>;
}

export interface ExecOptions {
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  input?: Uint8Array | string | Readable;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: RunOptions['onLine'];
}

export class DockerUnavailableError extends Error {
  constructor(message = 'Docker is not running') {
    super(message);
  }
}

export class Docker {
  readonly cli: string;
  private readonly runner: CommandRunner;

  constructor(cli: string, runner: CommandRunner) {
    this.cli = cli;
    this.runner = runner;
  }

  run(args: readonly string[], options?: RunOptions): Promise<RunResult> {
    return this.runner(this.cli, args, options);
  }

  checked(args: readonly string[], options?: RunOptions): Promise<RunResult> {
    return runChecked(this.runner, this.cli, args, options);
  }

  /** The engine version, or null when the engine does not answer. */
  async serverVersion(timeoutMs = 15_000): Promise<string | null> {
    const result = await this.run(['version', '--format', '{{.Server.Version}}'], { timeoutMs });
    const version = result.stdout.toString('utf8').trim();
    return result.code === 0 && version ? version : null;
  }

  async imageExists(tag: string): Promise<boolean> {
    return (await this.run(['image', 'inspect', '--format', '{{.Id}}', tag], { timeoutMs: 30_000 })).code === 0;
  }

  async build(contextDir: string, tag: string, role: string, onLine?: RunOptions['onLine'], signal?: AbortSignal) {
    await this.checked(['build', '--progress', 'plain', '--label', `${LABEL}=${role}`, '--tag', tag, contextDir], {
      onLine,
      signal,
    });
  }

  async volumeExists(name: string): Promise<boolean> {
    return (await this.run(['volume', 'inspect', name], { timeoutMs: 30_000 })).code === 0;
  }

  async createVolume(name: string, role: string): Promise<void> {
    if (!(await this.volumeExists(name))) {
      await this.checked(['volume', 'create', '--label', `${LABEL}=${role}`, name]);
    }
  }

  async removeVolume(name: string): Promise<void> {
    const result = await this.run(['volume', 'rm', '--force', name]);
    if (result.code !== 0 && (await this.volumeExists(name))) {
      throw new CommandError(this.cli, ['volume', 'rm', name], result);
    }
  }

  async inspectContainer(name: string): Promise<ContainerInfo | null> {
    const result = await this.run(['container', 'inspect', name], { timeoutMs: 30_000 });
    if (result.code !== 0) {
      return null;
    }
    const [raw] = JSON.parse(result.stdout.toString('utf8')) as {
      Name: string;
      State: { Running: boolean };
      Config: { Image: string; Labels: Record<string, string> | null };
      HostConfig: { PortBindings: Record<string, { HostPort: string }[] | null> | null };
    }[];
    const ports: Record<number, number> = {};
    for (const [key, bindings] of Object.entries(raw.HostConfig.PortBindings ?? {})) {
      const hostPort = Number(bindings?.[0]?.HostPort);
      if (hostPort) {
        ports[Number.parseInt(key, 10)] = hostPort;
      }
    }
    return {
      name: raw.Name.replace(/^\//, ''),
      running: raw.State.Running,
      image: raw.Config.Image,
      ports,
      labels: raw.Config.Labels ?? {},
    };
  }

  async removeContainer(name: string): Promise<void> {
    await this.run(['container', 'rm', '--force', '--volumes=false', name], { timeoutMs: 60_000 });
  }

  /** Names of containers carrying the given role label (running or not). */
  async containersWithRole(role: string): Promise<string[]> {
    const result = await this.checked(['container', 'ls', '--all', '--filter', `label=${LABEL}=${role}`, '--format', '{{.Names}}']);
    return result.stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
  }

  exec(container: string, command: readonly string[], options: ExecOptions = {}): Promise<RunResult> {
    const args = ['exec'];
    if (options.input !== undefined) {
      args.push('--interactive');
    }
    if (options.user) {
      args.push('--user', options.user);
    }
    if (options.workdir) {
      args.push('--workdir', options.workdir);
    }
    for (const [name, value] of Object.entries(options.env ?? {})) {
      args.push('--env', `${name}=${value}`);
    }
    args.push(container, ...command);
    return this.run(args, {
      input: options.input,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onLine: options.onLine,
    });
  }

  async execChecked(container: string, command: readonly string[], options: ExecOptions = {}): Promise<RunResult> {
    const result = await this.exec(container, command, options);
    if (result.code !== 0) {
      throw new CommandError(this.cli, ['exec', container, ...command], result);
    }
    return result;
  }
}

/** Formats one `--mount` value. Fields with commas or quotes are quoted CSV-style, as docker expects. */
export function mountArg(fields: Record<string, string | true>): string {
  return Object.entries(fields)
    .map(([key, value]) => {
      const field = value === true ? key : `${key}=${value}`;
      return /[",]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
    })
    .join(',');
}
