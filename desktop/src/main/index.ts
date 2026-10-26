/** Electron main process: window, security settings, services and IPC. */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, session, shell } from 'electron';
import { z } from 'zod';
import type { Snapshot } from '../shared/api.ts';
import { FakeRuntime } from './fake-runtime.ts';
import { Game } from './game.ts';
import { channelName, registerIpc } from './ipc.ts';
import { currentPlatform } from './platform/index.ts';
import type { Platform } from './platform/types.ts';
import { DockerRuntime } from './runtime.ts';
import type { GameRuntime } from './runtime.ts';
import { GitHubContentSource } from './services/content/github.ts';
import { LocalContentSource } from './services/content/local.ts';
import type { ContentSource } from './services/content/source.ts';
import { PackageStore } from './services/content/store.ts';
import { runCommand } from './services/process.ts';
import { StateStore } from './services/state.ts';

// Tests and the "clean profile" checks can point the app at another data folder.
if (process.env.BUGDETECTIVE_USER_DATA) {
  app.setPath('userData', resolve(process.env.BUGDETECTIVE_USER_DATA));
}

const isE2E = process.env.BUGDETECTIVE_E2E === '1' && !app.isPackaged;
const appRoot = app.getAppPath();
const devRendererUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;

const contentConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), repoPath: z.string(), manifestPath: z.string() }),
  z.object({
    kind: z.literal('github'),
    repository: z.string(),
    release: z.string().optional(),
    baseUrl: z.string().optional(),
  }),
]);

/**
 * Development uses the local SupportDesk checkout. The installed app downloads from GitHub, unless
 * %APPDATA%\Bug Detective\content-source.json chooses another source.
 */
function contentSource(): ContentSource {
  const configFile = join(app.getPath('userData'), 'content-source.json');
  const packageJson = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
    bugDetective: { contentRepository: string; contentRelease: string };
  };
  let config: z.infer<typeof contentConfigSchema> = app.isPackaged
    ? { kind: 'github', repository: packageJson.bugDetective.contentRepository, release: packageJson.bugDetective.contentRelease }
    : {
        kind: 'local',
        repoPath: process.env.BUGDETECTIVE_SUPPORTDESK ?? resolve(appRoot, '..', 'supportdesk'),
        manifestPath: process.env.BUGDETECTIVE_MANIFEST ?? join(appRoot, 'build', 'stage-packages', 'manifest.json'),
      };
  if (existsSync(configFile)) {
    config = contentConfigSchema.parse(JSON.parse(readFileSync(configFile, 'utf8')));
  }
  return config.kind === 'local'
    ? new LocalContentSource({ repoPath: config.repoPath, manifestPath: config.manifestPath, runner: runCommand })
    : new GitHubContentSource({ repository: config.repository, release: config.release, baseUrl: config.baseUrl });
}

const platform: Platform | null = isE2E ? null : currentPlatform();

function runtime(): GameRuntime {
  if (!platform) {
    return new FakeRuntime(process.env.BUGDETECTIVE_E2E_SCENARIO);
  }
  const contextRoot = app.isPackaged ? join(process.resourcesPath, 'docker') : join(appRoot, 'build', 'docker');
  return new DockerRuntime(platform, { contextRoot });
}

/** Opens an allowlisted URL with the platform's browser command (WSL: the Windows browser). */
async function openUrl(url: string): Promise<void> {
  const command = platform?.browserCommand(url);
  if (!command) {
    await shell.openExternal(url);
    return;
  }
  const child = spawn(command.command, command.args, { detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => {});
  child.unref();
}

function hardenSessions(): void {
  // No permission (camera, notifications, ...) is ever needed.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      const allowed = devRendererUrl ? url.startsWith(devRendererUrl) : url.startsWith('file://');
      if (!allowed) {
        event.preventDefault();
      }
    });
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: 'Bug Detective',
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  window.once('ready-to-show', () => window.show());
  if (devRendererUrl) {
    void window.loadURL(devRendererUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return window;
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  hardenSessions();

  const userData = app.getPath('userData');
  let window: BrowserWindow | null = null;
  const game = new Game({
    store: new StateStore(userData),
    packages: new PackageStore(join(userData, 'packages')),
    content: contentSource(),
    runtime: runtime(),
    appVersion: app.getVersion(),
    versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
    onChange: (snapshot: Snapshot) => window?.webContents.send(channelName('snapshot'), snapshot),
  });
  const language = app.getLocale().toLowerCase().startsWith('pt') ? 'pt' : 'en';
  await game.init(language);

  registerIpc(game, devRendererUrl ? new URL(devRendererUrl).origin : null, openUrl);
  window = createWindow();

  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.on('window-all-closed', () => app.quit());

  // Detects Docker stopping or starting during a session (shown as a banner in the UI).
  const poll = async () => {
    await game.refreshDockerState();
  };
  void poll().then(() => game.checkPrerequisites().catch(() => {}));
  setInterval(() => void poll(), isE2E ? 1000 : 10_000);
  // Leftover QA containers from a crash are removed once Docker answers.
  void game.cleanupLeftovers();
}

void main();
