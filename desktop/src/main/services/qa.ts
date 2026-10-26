/**
 * QA orchestration. Each run uses a fresh container from the QA image:
 *   - the workspace volume is mounted read-only; the CLI copies it without node_modules, .git and databases;
 *   - the stage package (app data folder) is bind-mounted read-only at /package;
 *   - dependencies come from the cache volume, keyed by the lockfile;
 * then the SupportDesk QA CLI runs with --json. The container is always removed afterward.
 * The player's container, dev server, database and files are never touched.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Language, QaResult } from '../../shared/types.ts';
import { readTar } from './content/archive.ts';
import { LABEL, mountArg } from './docker.ts';
import type { Docker } from './docker.ts';
import type { RunOptions } from './process.ts';
import { resourceNames } from './workspace.ts';
import type { ResourceNames } from './workspace.ts';

const RESULT_PATH = '/tmp/qa-result.json';
/** Extra time on top of the CLI's own timeout for container start-up and cleanup. */
const OUTER_GRACE_SECONDS = 90;

export class QaInfrastructureError extends Error {}

const qaResultSchema = z.object({
  ticket: z.number().int(),
  gate: z.union([z.literal(1), z.literal(2)]),
  status: z.enum(['passed', 'failed', 'timeout']),
  message: z.string(),
  tests: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['passed', 'failed', 'skipped', 'unfinished']),
      error: z.string().optional(),
    }),
  ),
  durationMs: z.number(),
});

/** Parses and validates the CLI's --json output. */
export function parseQaResult(json: string, ticket: number): QaResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new QaInfrastructureError('The QA result is not valid JSON');
  }
  const parsed = qaResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new QaInfrastructureError(`Unexpected QA result: ${parsed.error.issues[0]?.message}`);
  }
  if (parsed.data.ticket !== ticket) {
    throw new QaInfrastructureError(`QA result is for ticket ${parsed.data.ticket}, expected ${ticket}`);
  }
  return parsed.data;
}

/** The result recorded when the container itself had to be stopped (the CLI never reported). */
export function outerTimeoutResult(ticket: number, timeoutSeconds: number, durationMs: number): QaResult {
  return {
    ticket,
    gate: 1,
    status: 'timeout',
    message: `QA exceeded the time limit of ${timeoutSeconds} seconds.`,
    tests: [],
    durationMs,
  };
}

export interface QaRunRequest {
  ticket: number;
  language: Language;
  timeoutSeconds: number;
  /** Host folder of the extracted stage package. */
  packageDir: string;
  onLine?: RunOptions['onLine'];
}

export interface QaRunnerOptions {
  docker: Docker;
  image: string;
  dockerHostPath: (path: string) => string;
  names?: ResourceNames;
}

export class QaRunner {
  private readonly docker: Docker;
  private readonly image: string;
  private readonly dockerHostPath: (path: string) => string;
  private readonly names: ResourceNames;

  constructor(options: QaRunnerOptions) {
    this.docker = options.docker;
    this.image = options.image;
    this.dockerHostPath = options.dockerHostPath;
    this.names = options.names ?? resourceNames();
  }

  /**
   * QA runs need no network once dependencies are cached (Playwright talks to 127.0.0.1 inside
   * the container), so they run with --network none: offline by design, and the player's code
   * cannot reach anything outside. Installing dependencies does use the network.
   */
  private baseArgs(name: string, options: { packageDir?: string; network: boolean }): string[] {
    const args = [
      'run',
      '--name',
      name,
      '--label',
      `${LABEL}=qa`,
      '--init',
      '--network',
      options.network ? 'bridge' : 'none',
      '--mount',
      mountArg({ type: 'volume', src: this.names.volume, dst: '/workspace', readonly: true }),
      '--mount',
      mountArg({ type: 'volume', src: this.names.cacheVolume, dst: '/cache' }),
    ];
    const { packageDir } = options;
    if (packageDir) {
      args.push('--mount', mountArg({ type: 'bind', src: this.dockerHostPath(packageDir), dst: '/package', readonly: true }));
    }
    return args;
  }

  /** Runs QA for one ticket. Returns the CLI's result; throws QaInfrastructureError if QA could not run. */
  async run(request: QaRunRequest): Promise<QaResult> {
    const name = `${this.names.prefix}-qa-${randomUUID().slice(0, 8)}`;
    const startedAt = Date.now();
    const args = [
      ...this.baseArgs(name, { packageDir: request.packageDir, network: false }),
      this.image,
      '--ticket',
      String(request.ticket),
      '--workspace',
      '/workspace',
      '--package',
      '/package',
      '--lang',
      request.language,
      '--json',
      RESULT_PATH,
      '--timeout',
      String(request.timeoutSeconds),
      '--deps-cache',
      '/cache/deps',
    ];
    try {
      const run = await this.docker.run(args, {
        timeoutMs: (request.timeoutSeconds + OUTER_GRACE_SECONDS) * 1000,
        onLine: request.onLine,
      });
      if (run.timedOut) {
        return outerTimeoutResult(request.ticket, request.timeoutSeconds, Date.now() - startedAt);
      }
      const copied = await this.docker.run(['container', 'cp', `${name}:${RESULT_PATH}`, '-'], { timeoutMs: 60_000 });
      if (copied.code !== 0) {
        const output = `${run.stderr}\n${run.stdout.toString('utf8')}`.trim().split('\n').slice(-20).join('\n');
        throw new QaInfrastructureError(`QA did not produce a result (exit code ${run.code}).\n${output}`);
      }
      const [file] = await readTar(copied.stdout);
      if (!file) {
        throw new QaInfrastructureError('QA did not produce a result file');
      }
      return parseQaResult(Buffer.from(file.data).toString('utf8'), request.ticket);
    } finally {
      await this.docker.removeContainer(name);
    }
  }

  /**
   * Installs the workspace's dependencies into the cache volume (npm ci, needs internet), so
   * later QA runs and the player's workspace work offline.
   */
  async prepareDependencies(ticket: number, onLine?: RunOptions['onLine']): Promise<void> {
    const name = `${this.names.prefix}-qa-deps-${randomUUID().slice(0, 8)}`;
    try {
      const run = await this.docker.run(
        [
          ...this.baseArgs(name, { network: true }),
          this.image,
          '--ticket',
          String(ticket),
          '--workspace',
          '/workspace',
          '--deps-cache',
          '/cache/deps',
          '--deps-only',
          '--timeout',
          '1200',
        ],
        { timeoutMs: 25 * 60_000, onLine },
      );
      if (run.code !== 0) {
        throw new QaInfrastructureError(
          `Installing dependencies failed (exit code ${run.code}). Check your internet connection.\n${run.stdout.toString('utf8').split('\n').slice(-15).join('\n')}`,
        );
      }
    } finally {
      await this.docker.removeContainer(name);
    }
  }

  /** Removes QA containers left behind by a crash. */
  async cleanupLeftovers(): Promise<void> {
    for (const name of await this.docker.containersWithRole('qa')) {
      if (name.startsWith(`${this.names.prefix}-qa-`)) {
        await this.docker.removeContainer(name);
      }
    }
  }
}
