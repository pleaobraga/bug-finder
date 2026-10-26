/**
 * Export and restore of progress as a single .bdsave zip:
 *   manifest.json        format, app version, schema version and SHA-256 of every other entry
 *   state.json           the game state
 *   workspace.bundle     `git bundle` of the workspace repository (player/* branches, stage tags)
 *   packages/stage-N.zip the downloaded stage packages
 */
import { z } from 'zod';
import type { RuleContext } from '../../shared/kanban.ts';
import { SCHEMA_VERSION } from '../../shared/types.ts';
import type { GameState } from '../../shared/types.ts';
import { readZip, sha256Hex, writeZip } from './content/archive.ts';
import type { ArchiveFile } from './content/archive.ts';
import { migrateState } from './state.ts';

export const SAVE_EXTENSION = 'bdsave';
const MAX_SAVE_BYTES = 512 * 1024 * 1024;

export const saveManifestSchema = z.object({
  format: z.literal('bug-detective-save'),
  formatVersion: z.literal(1),
  appVersion: z.string().max(50),
  schemaVersion: z.number().int().min(1),
  createdAt: z.string(),
  files: z.record(z.string().regex(/^(state\.json|workspace\.bundle|packages\/stage-\d{1,2}\.zip)$/), z.string().regex(/^[0-9a-f]{64}$/)),
});

export type SaveManifest = z.infer<typeof saveManifestSchema>;

export class InvalidSaveError extends Error {}

export interface SaveContents {
  state: GameState;
  bundle: Uint8Array | null;
  packages: Map<number, Uint8Array>;
}

export function createSave(contents: SaveContents, appVersion: string, now: string): Uint8Array {
  const files: ArchiveFile[] = [
    { path: 'state.json', data: Buffer.from(`${JSON.stringify(contents.state, null, 2)}\n`), executable: false },
  ];
  if (contents.bundle) {
    files.push({ path: 'workspace.bundle', data: contents.bundle, executable: false });
  }
  for (const [stage, zip] of [...contents.packages].sort(([a], [b]) => a - b)) {
    files.push({ path: `packages/stage-${stage}.zip`, data: zip, executable: false });
  }
  const manifest: SaveManifest = {
    format: 'bug-detective-save',
    formatVersion: 1,
    appVersion,
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    files: Object.fromEntries(files.map((file) => [file.path, sha256Hex(file.data)])),
  };
  return writeZip([...files, { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)), executable: false }]);
}

export interface ValidatedSave extends SaveContents {
  manifest: SaveManifest;
}

/** Validates a .bdsave completely (manifest, checksums, state schema) before anything is restored. */
export function readSave(bytes: Uint8Array, ctx: RuleContext): ValidatedSave {
  if (bytes.length > MAX_SAVE_BYTES) {
    throw new InvalidSaveError('The file is too large to be a Bug Detective save');
  }
  let files: ArchiveFile[];
  try {
    files = readZip(bytes);
  } catch {
    throw new InvalidSaveError('The file is not a Bug Detective save (not a valid zip)');
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const manifestFile = byPath.get('manifest.json');
  if (!manifestFile) {
    throw new InvalidSaveError('The save has no manifest');
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(Buffer.from(manifestFile.data).toString('utf8'));
  } catch {
    throw new InvalidSaveError('The save manifest is not valid JSON');
  }
  const parsed = saveManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    throw new InvalidSaveError(`The save manifest is invalid: ${parsed.error.issues[0]?.message}`);
  }
  const manifest = parsed.data;
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new InvalidSaveError('This save was created by a newer version of Bug Detective');
  }
  if (!manifest.files['state.json']) {
    throw new InvalidSaveError('The save has no game state');
  }
  for (const [path, checksum] of Object.entries(manifest.files)) {
    const file = byPath.get(path);
    if (!file || sha256Hex(file.data) !== checksum) {
      throw new InvalidSaveError(`The save is damaged: ${path} does not match its checksum`);
    }
  }
  for (const path of byPath.keys()) {
    if (path !== 'manifest.json' && !manifest.files[path]) {
      throw new InvalidSaveError(`The save contains an unexpected file: ${path}`);
    }
  }

  let state: GameState;
  try {
    state = migrateState(JSON.parse(Buffer.from(byPath.get('state.json')!.data).toString('utf8')), ctx);
  } catch (error) {
    throw new InvalidSaveError(`The saved game state is invalid: ${(error as Error).message.slice(0, 300)}`);
  }
  if (state.tickets.length > 0 && !manifest.files['workspace.bundle']) {
    throw new InvalidSaveError('The save has progress but no workspace repository');
  }

  const packages = new Map<number, Uint8Array>();
  for (const path of Object.keys(manifest.files)) {
    const match = /^packages\/stage-(\d+)\.zip$/.exec(path);
    if (match) {
      packages.set(Number(match[1]), byPath.get(path)!.data);
    }
  }
  for (const ticket of state.tickets) {
    if (!packages.has(ticket.ticket)) {
      throw new InvalidSaveError(`The save is missing the package for ticket ${ticket.ticket}`);
    }
  }
  return { manifest, state, bundle: byPath.get('workspace.bundle')?.data ?? null, packages };
}
