import { describe, expect, it } from 'vitest';
import { createLinuxPlatform, isWsl } from '../../src/main/platform/linux.ts';
import type { RunResult } from '../../src/main/services/process.ts';

const ok = (stdout: string, code = 0): RunResult => ({ code, stdout: Buffer.from(stdout), stderr: '', timedOut: false });

const CODE_CMD = '@echo off\r\n"%~dp0..\\Code.exe" "%~dp0..\\e646868227\\resources\\app\\out\\cli.js" %*\r\n';
const VSCODE = '/mnt/c/Users/João Silva/AppData/Local/Programs/Microsoft VS Code';

function fakeFs(files: Record<string, string>) {
  return {
    fileExists: (file: string) => file in files,
    readText: (file: string) => {
      if (!(file in files)) throw new Error('ENOENT');
      return files[file];
    },
  };
}

/** Answers the one cmd.exe call that reads the Windows folders. */
const windowsRunner = async (command: string, args: readonly string[]) => {
  if (command.endsWith('cmd.exe')) {
    return ok('C:\\Users\\João Silva\\AppData\\Local|C:\\Program Files|C:\\WINDOWS\r\n');
  }
  if (command.endsWith('tasklist.exe')) {
    return ok(args.includes('IMAGENAME eq Docker Desktop.exe') ? '"Docker Desktop.exe","1234","Console"\r\n' : '');
  }
  return ok('', 1);
};

const wslEnv = {
  WSL_DISTRO_NAME: 'Ubuntu-22.04',
  PATH: '/home/u/.vscode-server/bin/abc/bin/remote-cli:/usr/local/bin:/usr/bin:/mnt/c/Program Files/Docker/Docker/resources/bin',
};
const wslFiles = {
  '/proc/version': 'Linux version 5.15.146.1-microsoft-standard-WSL2',
  '/mnt/c': '',
  '/usr/bin/docker': '',
  '/home/u/.vscode-server/bin/abc/bin/remote-cli/code': '',
  '/mnt/c/Program Files/Docker/Docker/resources/bin/docker': '',
  '/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe': '',
  [`${VSCODE}/Code.exe`]: '',
  [`${VSCODE}/bin/code.cmd`]: CODE_CMD,
  [`${VSCODE}/e646868227/resources/app/out/cli.js`]: '',
};

describe('Linux platform on WSL 2', () => {
  const platform = () => createLinuxPlatform({ env: wslEnv, runner: windowsRunner, ...fakeFs(wslFiles) });

  it('detects WSL', () => {
    expect(isWsl({ env: wslEnv, readText: () => '' })).toBe(true);
    expect(isWsl({ env: {}, readText: () => 'Linux version 6.8.0-generic' })).toBe(false);
  });

  it('uses the docker CLI from the WSL integration, not the Windows shim', async () => {
    expect(await platform().locateDocker()).toEqual({
      cli: '/usr/bin/docker',
      desktopApp: '/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe',
    });
  });

  it('reports no CLI while Docker Desktop is stopped (the integration links disappear)', async () => {
    const files = { ...wslFiles } as Record<string, string>;
    delete files['/usr/bin/docker'];
    const stopped = createLinuxPlatform({ env: wslEnv, runner: windowsRunner, ...fakeFs(files) });
    expect((await stopped.locateDocker()).cli).toBeNull();
    expect(await stopped.isDockerDesktopRunning()).toBe(true);
  });

  it('runs Windows VS Code through interop, passing ELECTRON_RUN_AS_NODE with WSLENV', async () => {
    const cli = (await platform().locateVSCode())!;
    expect(cli.source).toBe('user');
    expect(cli.command).toBe(`${VSCODE}/Code.exe`);
    expect(cli.baseArgs).toEqual(['C:\\Users\\João Silva\\AppData\\Local\\Programs\\Microsoft VS Code\\e646868227\\resources\\app\\out\\cli.js']);
    expect(cli.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(cli.env.WSLENV?.split(':')).toContain('ELECTRON_RUN_AS_NODE');
  });

  it('never uses the VS Code Server remote CLI', async () => {
    const files = { ...wslFiles } as Record<string, string>;
    delete files[`${VSCODE}/Code.exe`];
    const noWindowsCode = createLinuxPlatform({ env: wslEnv, runner: windowsRunner, ...fakeFs(files) });
    expect(await noWindowsCode.locateVSCode()).toBeNull();
  });

  it('checks WSL 2 from the kernel', async () => {
    expect(await platform().checkWsl()).toMatchObject({ installed: true, version2: true });
    const wsl1 = createLinuxPlatform({ env: wslEnv, runner: windowsRunner, ...fakeFs({ ...wslFiles, '/proc/version': 'Linux version 4.4.0-19041-Microsoft' }) });
    expect(await wsl1.checkWsl()).toMatchObject({ installed: true, version2: false });
  });

  it('opens URLs in the Windows browser and keeps Linux paths for Docker', () => {
    expect(platform().browserCommand('http://127.0.0.1:5173/')).toEqual({ command: '/mnt/c/Windows/explorer.exe', args: ['http://127.0.0.1:5173/'] });
    expect(platform().dockerHostPath('/home/u/.config/Bug Detective/packages/stage-1')).toBe('/home/u/.config/Bug Detective/packages/stage-1');
  });
});

describe('Linux platform on plain Linux', () => {
  const env = { PATH: '/usr/local/bin:/usr/bin' };
  const files = { '/proc/version': 'Linux version 6.8.0-45-generic', '/usr/bin/docker': '', '/usr/bin/code': '' };
  const platform = () => createLinuxPlatform({ env, runner: async () => ok('', 1), ...fakeFs(files) });

  it('uses Docker Engine and VS Code for Linux', async () => {
    expect(await platform().locateDocker()).toEqual({ cli: '/usr/bin/docker', desktopApp: null });
    expect(await platform().locateVSCode()).toMatchObject({ source: 'path', command: '/usr/bin/code', baseArgs: [] });
  });

  it('does not need WSL and uses the default browser opener', async () => {
    expect(await platform().checkWsl()).toMatchObject({ installed: true, version2: true });
    expect(platform().browserCommand('http://127.0.0.1:5173/')).toBeNull();
  });
});
