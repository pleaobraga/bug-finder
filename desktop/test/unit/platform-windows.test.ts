import { describe, expect, it } from 'vitest';
import { createWindowsPlatform, decodeWslOutput, parseWslList } from '../../src/main/platform/windows.ts';
import type { RunResult } from '../../src/main/services/process.ts';
import { attachedContainerUri } from '../../src/main/services/vscode.ts';

const CODE_CMD = `@echo off
setlocal
set VSCODE_DEV=
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\\Code.exe" "%~dp0..\\e646868227\\resources\\app\\out\\cli.js" %*
IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%
endlocal
`;

function fakeFs(files: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(files).map(([path, text]) => [path.toLowerCase(), text]));
  return {
    fileExists: (path: string) => path.toLowerCase() in lower,
    readText: (path: string) => {
      const text = lower[path.toLowerCase()];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
  };
}

const ok = (stdout: string | Buffer, code = 0): RunResult => ({ code, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: '', timedOut: false });

describe('VS Code CLI resolution', () => {
  const user = 'C:\\Users\\João Silva\\AppData\\Local\\Programs\\Microsoft VS Code';
  const system = 'C:\\Program Files\\Microsoft VS Code';
  const env = { LOCALAPPDATA: 'C:\\Users\\João Silva\\AppData\\Local', ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Windows\\System32' };

  it('finds the per-user install and runs Code.exe with the CLI entry point (no cmd.exe)', async () => {
    const platform = createWindowsPlatform({
      env,
      ...fakeFs({
        [`${user}\\bin\\code.cmd`]: CODE_CMD,
        [`${user}\\Code.exe`]: '',
        [`${user}\\e646868227\\resources\\app\\out\\cli.js`]: '',
      }),
    });
    const cli = (await platform.locateVSCode())!;
    expect(cli.source).toBe('user');
    expect(cli.command).toBe(`${user}\\Code.exe`);
    expect(cli.baseArgs).toEqual([`${user}\\e646868227\\resources\\app\\out\\cli.js`]);
    expect(cli.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('finds the system-wide install with the classic layout', async () => {
    const platform = createWindowsPlatform({
      env,
      ...fakeFs({
        [`${system}\\bin\\code.cmd`]: '@echo off\r\n"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*\r\n',
        [`${system}\\Code.exe`]: '',
        [`${system}\\resources\\app\\out\\cli.js`]: '',
      }),
    });
    const cli = (await platform.locateVSCode())!;
    expect(cli.source).toBe('system');
    expect(cli.baseArgs).toEqual([`${system}\\resources\\app\\out\\cli.js`]);
  });

  it('prefers the install on PATH', async () => {
    const custom = 'D:\\Tools\\VS Code';
    const platform = createWindowsPlatform({
      env: { ...env, PATH: `C:\\Windows;"${custom}\\bin"` },
      ...fakeFs({
        [`${custom}\\bin\\code.cmd`]: CODE_CMD,
        [`${custom}\\Code.exe`]: '',
        [`${custom}\\e646868227\\resources\\app\\out\\cli.js`]: '',
        [`${user}\\bin\\code.cmd`]: CODE_CMD,
      }),
    });
    expect((await platform.locateVSCode())!.source).toBe('path');
  });

  it('reports VS Code as missing when only a broken launcher exists', async () => {
    const platform = createWindowsPlatform({ env, ...fakeFs({ [`${user}\\bin\\code.cmd`]: CODE_CMD }) });
    expect(await platform.locateVSCode()).toBeNull();
  });
});

describe('Docker Desktop detection', () => {
  it('finds docker.exe and Docker Desktop in Program Files', async () => {
    const root = 'C:\\Program Files\\Docker\\Docker';
    const platform = createWindowsPlatform({
      env: { ProgramFiles: 'C:\\Program Files', PATH: '' },
      ...fakeFs({ [`${root}\\resources\\bin\\docker.exe`]: '', [`${root}\\Docker Desktop.exe`]: '' }),
    });
    expect(await platform.locateDocker()).toEqual({ cli: `${root}\\resources\\bin\\docker.exe`, desktopApp: `${root}\\Docker Desktop.exe` });
  });

  it('reports Docker as absent', async () => {
    const platform = createWindowsPlatform({ env: { ProgramFiles: 'C:\\Program Files', PATH: '' }, ...fakeFs({}) });
    expect(await platform.locateDocker()).toEqual({ cli: null, desktopApp: null });
  });
});

describe('WSL detection', () => {
  const list = '  NAME              STATE           VERSION\r\n* Ubuntu-22.04      Running         2\r\n  docker-desktop    Stopped         2\r\n';

  it('decodes UTF-16LE output from wsl.exe', () => {
    expect(decodeWslOutput(Buffer.from(`\uFEFF${list}`, 'utf16le'))).toBe(list);
    expect(decodeWslOutput(Buffer.from(list, 'utf8'))).toBe(list);
  });

  it('parses wsl -l -v', () => {
    expect(parseWslList(list)).toEqual([
      { name: 'Ubuntu-22.04', version: 2 },
      { name: 'docker-desktop', version: 2 },
    ]);
  });

  it('checks WSL 2 through exit codes and the distro list', async () => {
    const runner = async (_command: string, args: readonly string[]) =>
      args[0] === '--status' ? ok(Buffer.from('Default Version: 2\r\n', 'utf16le')) : ok(Buffer.from(list, 'utf16le'));
    const platform = createWindowsPlatform({ env: { SystemRoot: 'C:\\Windows' }, runner, ...fakeFs({}) });
    expect(await platform.checkWsl()).toMatchObject({ installed: true, version2: true });
  });

  it('reports WSL as missing when wsl --status fails', async () => {
    const runner = async () => ok('', 1);
    const platform = createWindowsPlatform({ env: {}, runner, ...fakeFs({}) });
    expect(await platform.checkWsl()).toMatchObject({ installed: false, version2: false });
  });

  it('reports WSL 1 only', async () => {
    const runner = async (_command: string, args: readonly string[]) =>
      args[0] === '--status' ? ok('Default Version: 1\n') : ok('  NAME STATE VERSION\n* Legacy Running 1\n');
    const platform = createWindowsPlatform({ env: {}, runner, ...fakeFs({}) });
    expect(await platform.checkWsl()).toMatchObject({ installed: true, version2: false });
  });
});

describe('attached-container URI', () => {
  it('hex-encodes the container name JSON', () => {
    const uri = attachedContainerUri('bugdetective-workspace');
    const hex = /^vscode-remote:\/\/attached-container\+([0-9a-f]+)\/workspaces\/supportdesk$/.exec(uri)![1];
    expect(JSON.parse(Buffer.from(hex, 'hex').toString())).toEqual({ containerName: '/bugdetective-workspace' });
  });

  it('only accepts valid container names', () => {
    expect(() => attachedContainerUri('x" --evil')).toThrow();
    expect(() => attachedContainerUri('../x')).toThrow();
  });
});
