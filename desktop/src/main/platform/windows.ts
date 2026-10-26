/**
 * Windows implementation of the platform module: Docker Desktop, WSL2 and VS Code detection.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { win32 } from 'node:path';
import { runCommand } from '../services/process.ts';
import type { CommandRunner } from '../services/process.ts';
import type { DockerLocations, Platform, VSCodeCli, WslStatus } from './types.ts';

const path = win32;

export interface WindowsDeps {
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  fileExists: (file: string) => boolean;
  readText: (file: string) => string;
}

const defaultDeps = (): WindowsDeps => ({
  env: process.env,
  runner: runCommand,
  fileExists: existsSync,
  readText: (file) => readFileSync(file, 'utf8'),
});

/** wsl.exe writes UTF-16LE unless WSL_UTF8=1 is honored; detect which one we got. */
export function decodeWslOutput(buffer: Buffer): string {
  const sample = buffer.subarray(0, Math.min(buffer.length, 200));
  let zeros = 0;
  for (let index = 1; index < sample.length; index += 2) {
    if (sample[index] === 0) {
      zeros += 1;
    }
  }
  const utf16 = sample.length >= 2 && zeros >= sample.length / 4;
  return (utf16 ? buffer.toString('utf16le') : buffer.toString('utf8')).replace(/^\uFEFF/, '').replace(/\0/g, '');
}

/** Parses `wsl -l -v`. Returns the distros with their WSL version. */
export function parseWslList(text: string): { name: string; version: number }[] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.replace(/^\s*\*?\s*/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      return { name: parts.slice(0, -2).join(' '), version: Number(parts.at(-1)) };
    })
    .filter((distro) => distro.name && Number.isInteger(distro.version));
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const value = env.Path ?? env.PATH ?? '';
  return value
    .split(';')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function findOnPath(deps: WindowsDeps, file: string): string | null {
  for (const dir of pathDirs(deps.env)) {
    const candidate = path.join(dir, file);
    if (deps.fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolves the VS Code CLI without going through cmd.exe: bin\code.cmd only runs
 * `Code.exe <commit>\resources\app\out\cli.js` with ELECTRON_RUN_AS_NODE=1, so we do the same.
 * Spawning code.cmd directly fails with EINVAL since the CVE-2024-27980 fix.
 */
export function resolveVSCodeLauncher(deps: WindowsDeps, launcher: string, source: VSCodeCli['source']): VSCodeCli | null {
  const root = path.dirname(path.dirname(launcher));
  const exe = path.join(root, 'Code.exe');
  if (!deps.fileExists(exe)) {
    return null;
  }
  let cliJs: string | null = null;
  try {
    const match = /"%~dp0\.\.\\([^"]*?cli\.js)"/i.exec(deps.readText(launcher));
    if (match) {
      cliJs = path.join(root, match[1]);
    }
  } catch {
    // Fall through to the classic layout.
  }
  if (!cliJs || !deps.fileExists(cliJs)) {
    cliJs = path.join(root, 'resources', 'app', 'out', 'cli.js');
  }
  if (!deps.fileExists(cliJs)) {
    return null;
  }
  const env: NodeJS.ProcessEnv = { ...deps.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.VSCODE_DEV;
  return { source, launcher, command: exe, baseArgs: [cliJs], env };
}

export function createWindowsPlatform(overrides: Partial<WindowsDeps> = {}): Platform {
  const deps = { ...defaultDeps(), ...overrides };
  const { env, runner } = deps;
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const localAppData = env.LOCALAPPDATA ?? (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : null);
  const system32 = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32');

  return {
    id: 'windows',
    runner,

    async locateDocker(): Promise<DockerLocations> {
      const installedCli = path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe');
      const desktopApp = path.join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe');
      const cli = findOnPath(deps, 'docker.exe') ?? (deps.fileExists(installedCli) ? installedCli : null);
      return { cli, desktopApp: deps.fileExists(desktopApp) ? desktopApp : null };
    },

    async isDockerDesktopRunning() {
      const result = await runner(
        path.join(system32, 'tasklist.exe'),
        ['/FI', 'IMAGENAME eq Docker Desktop.exe', '/FO', 'CSV', '/NH'],
        { timeoutMs: 10_000 },
      );
      return result.code === 0 && result.stdout.toString('utf8').toLowerCase().includes('docker desktop.exe');
    },

    async startDockerDesktop(desktopApp) {
      const child = spawn(desktopApp, [], { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
      child.on('error', () => {});
      child.unref();
    },

    async checkWsl(): Promise<WslStatus> {
      const wsl = path.join(system32, 'wsl.exe');
      const wslEnv = { ...env, WSL_UTF8: '1' };
      const status = await runner(wsl, ['--status'], { env: wslEnv, timeoutMs: 20_000 });
      const statusText = decodeWslOutput(status.stdout);
      if (status.code !== 0) {
        return { installed: false, version2: false, detail: statusText.trim() || status.stderr.trim() };
      }
      const list = await runner(wsl, ['--list', '--verbose'], { env: wslEnv, timeoutMs: 20_000 });
      const distros = list.code === 0 ? parseWslList(decodeWslOutput(list.stdout)) : [];
      // "Default Version: 2" is localized, so only the trailing number is matched.
      const defaultIs2 = /:\s*2\s*$/m.test(statusText);
      const version2 = distros.some((distro) => distro.version === 2) || defaultIs2;
      const detail = distros.map((distro) => `${distro.name} (WSL ${distro.version})`).join(', ');
      return { installed: true, version2, detail };
    },

    async locateVSCode() {
      const onPath = findOnPath(deps, 'code.cmd');
      const candidates: [string | null, VSCodeCli['source']][] = [
        [onPath, 'path'],
        [localAppData && path.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'), 'user'],
        [path.join(programFiles, 'Microsoft VS Code', 'bin', 'code.cmd'), 'system'],
      ];
      for (const [launcher, source] of candidates) {
        if (launcher && deps.fileExists(launcher)) {
          const cli = resolveVSCodeLauncher(deps, launcher, source);
          if (cli) {
            return cli;
          }
        }
      }
      return null;
    },

    dockerHostPath(hostPath) {
      return path.resolve(hostPath);
    },

    isPortFree(port) {
      return new Promise((resolve) => {
        const server = createServer();
        server.once('error', () => resolve(false));
        server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
      });
    },
  };
}
