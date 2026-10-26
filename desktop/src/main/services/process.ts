/**
 * Runs external commands with spawn and an argument array. Never through a shell: commands and
 * arguments are passed to the OS as-is, so nothing is ever parsed or interpolated.
 */
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Data written to stdin, then stdin is closed. */
  input?: Uint8Array | string | Readable;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with each complete output line (stdout and stderr), for progress display. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Maximum bytes of stdout kept in memory (default 64 MB). */
  maxStdout?: number;
}

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

export type CommandRunner = (command: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

export class CommandError extends Error {
  readonly result: RunResult;
  readonly command: string;

  constructor(command: string, args: readonly string[], result: RunResult) {
    const detail = result.stderr.trim() || result.stdout.toString('utf8').trim();
    super(`${command} ${args.slice(0, 3).join(' ')} exited with code ${result.code}${detail ? `: ${detail.slice(-2000)}` : ''}`);
    this.command = command;
    this.result = result;
  }
}

function lineSplitter(onLine: (line: string) => void) {
  let pending = '';
  return {
    push(chunk: string) {
      pending += chunk;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        onLine(line);
      }
    },
    flush() {
      if (pending) {
        onLine(pending);
        pending = '';
      }
    },
  };
}

export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const maxStdout = options.maxStdout ?? 64 * 1024 * 1024;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const outLines = options.onLine && lineSplitter((line) => options.onLine!(line, 'stdout'));
    const errLines = options.onLine && lineSplitter((line) => options.onLine!(line, 'stderr'));

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes < maxStdout) {
        stdout.push(chunk);
        stdoutBytes += chunk.length;
      }
      outLines?.push(chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr = (stderr + text).slice(-256 * 1024);
      errLines?.push(text);
    });

    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs)
      : undefined;
    options.signal?.addEventListener('abort', kill, { once: true });

    const finish = (code: number) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener('abort', kill);
      outLines?.flush();
      errLines?.flush();
      resolve({ code, stdout: Buffer.concat(stdout), stderr, timedOut });
    };

    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));

    child.stdin.on('error', () => {});
    const { input } = options;
    if (input === undefined) {
      child.stdin.end();
    } else if (typeof input === 'string' || input instanceof Uint8Array) {
      child.stdin.end(input);
    } else {
      input.pipe(child.stdin);
    }
  });

/** Runs a command and throws CommandError unless it exits with code 0. */
export async function runChecked(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  options?: RunOptions,
): Promise<RunResult> {
  const result = await runner(command, args, options);
  if (result.code !== 0) {
    throw new CommandError(command, args, result);
  }
  return result;
}
