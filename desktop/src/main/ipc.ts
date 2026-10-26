/**
 * IPC handlers. Every input from the renderer is validated with zod here, in the main process,
 * and every result travels in an envelope so error codes survive the IPC boundary.
 */
import { basename } from 'node:path';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { EXTERNAL_LINKS } from '../shared/api.ts';
import type { Envelope } from '../shared/api.ts';
import { COLUMNS, LANGUAGES, MAX_QA_TIMEOUT_SECONDS, MIN_QA_TIMEOUT_SECONDS, THEMES, TICKET_COUNT } from '../shared/types.ts';
import type { Game } from './game.ts';
import { GameError } from './game.ts';
import { SAVE_EXTENSION } from './services/backup.ts';
import { DockerUnavailableError } from './services/docker.ts';

const ticket = z.number().int().min(1).max(TICKET_COUNT);
const none = z.tuple([]);

const schemas = {
  snapshot: none,
  checkPrerequisites: none,
  startDocker: none,
  installDevContainers: none,
  refreshEnvironment: none,
  installEnvironment: none,
  nextAssignment: none,
  move: z.tuple([ticket, z.enum(COLUMNS)]),
  askSenior: z.tuple([ticket]),
  revealSolution: z.tuple([ticket]),
  acceptReview: z.tuple([ticket]),
  markInboxRead: z.tuple([z.string().uuid()]),
  ticketContent: z.tuple([ticket, z.enum(LANGUAGES)]),
  workspaceStatus: none,
  openVSCode: none,
  openAppInBrowser: none,
  startDevServer: none,
  openExternal: z.tuple([z.enum(Object.keys(EXTERNAL_LINKS) as [keyof typeof EXTERNAL_LINKS])]),
  updateSettings: z.tuple([
    z
      .object({
        language: z.enum(LANGUAGES),
        qaTimeoutSeconds: z.number().int().min(MIN_QA_TIMEOUT_SECONDS).max(MAX_QA_TIMEOUT_SECONDS),
        theme: z.enum(THEMES),
      })
      .partial()
      .strict(),
  ]),
  exportProgress: none,
  inspectSave: none,
  restoreProgress: z.tuple([z.string().uuid()]),
} as const;

export type Channel = keyof typeof schemas;
export const CHANNELS = Object.keys(schemas) as Channel[];
export const channelName = (channel: Channel) => `bd:${channel}`;

/** Only our own renderer may call the API (file:// in production, the dev server in development). */
function trustedSender(event: IpcMainInvokeEvent, rendererOrigin: string | null): boolean {
  const url = event.senderFrame?.url ?? '';
  return rendererOrigin ? url.startsWith(rendererOrigin) : url.startsWith('file://');
}

function toEnvelopeError(error: unknown): Envelope<never> {
  if (error instanceof GameError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  if (error instanceof DockerUnavailableError) {
    return { ok: false, error: { code: 'dockerUnavailable', message: error.message } };
  }
  if (error instanceof z.ZodError) {
    return { ok: false, error: { code: 'invalidInput', message: error.issues[0]?.message ?? 'Invalid input' } };
  }
  return { ok: false, error: { code: 'failed', message: error instanceof Error ? error.message : String(error) } };
}

/** Opens an allowlisted URL; the platform may provide its own command (WSL opens the Windows browser). */
export type UrlOpener = (url: string) => Promise<void>;

export function registerIpc(game: Game, rendererOrigin: string | null, openUrl: UrlOpener = (url) => shell.openExternal(url)): void {
  const handlers: { [K in Channel]: (...args: z.infer<(typeof schemas)[K]>) => Promise<unknown> | unknown } = {
    snapshot: () => game.snapshot(),
    checkPrerequisites: () => game.checkPrerequisites(),
    startDocker: () => game.startDocker(),
    installDevContainers: () => game.installDevContainers(),
    refreshEnvironment: () => game.refreshEnvironment(),
    installEnvironment: () => game.installEnvironment(),
    nextAssignment: () => game.nextAssignment(),
    move: (n, to) => game.move(n, to),
    askSenior: (n) => game.askSenior(n),
    revealSolution: (n) => game.revealSolution(n),
    acceptReview: (n) => game.acceptReview(n),
    markInboxRead: (id) => game.markInboxRead(id),
    ticketContent: (n, language) => game.ticketContent(n, language),
    workspaceStatus: () => game.workspaceStatus(),
    openVSCode: () => game.openVSCode(),
    openAppInBrowser: async () => {
      const url = new URL(await game.appUrl());
      // Only the workspace app on the loopback address and its published port.
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
        throw new GameError('notAllowed');
      }
      await openUrl(url.href);
    },
    startDevServer: () => game.startDevServer(),
    openExternal: (link) => openUrl(EXTERNAL_LINKS[link]),
    updateSettings: (settings) => game.updateSettings(settings),
    exportProgress: async () => {
      const window = BrowserWindow.getFocusedWindow();
      const date = new Date().toISOString().slice(0, 10);
      const options = {
        title: 'Export progress',
        defaultPath: `bug-detective-${date}.${SAVE_EXTENSION}`,
        filters: [{ name: 'Bug Detective save', extensions: [SAVE_EXTENSION] }],
      };
      const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) {
        return { saved: false };
      }
      await game.exportProgress(result.filePath);
      return { saved: true, path: result.filePath };
    },
    inspectSave: async () => {
      const window = BrowserWindow.getFocusedWindow();
      const options = {
        title: 'Restore progress',
        properties: ['openFile' as const],
        filters: [{ name: 'Bug Detective save', extensions: [SAVE_EXTENSION] }],
      };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      const [file] = result.filePaths;
      if (result.canceled || !file) {
        return null;
      }
      return game.inspectSave(file, basename(file));
    },
    restoreProgress: (token) => game.restoreProgress(token),
  };

  for (const channel of CHANNELS) {
    ipcMain.handle(channelName(channel), async (event, ...raw: unknown[]): Promise<Envelope<unknown>> => {
      if (!trustedSender(event, rendererOrigin)) {
        return { ok: false, error: { code: 'notAllowed', message: 'Untrusted sender' } };
      }
      try {
        const args = schemas[channel].parse(raw) as never[];
        const value = await (handlers[channel] as (...input: never[]) => unknown)(...args);
        return { ok: true, value };
      } catch (error) {
        return toEnvelopeError(error);
      }
    });
  }
}
