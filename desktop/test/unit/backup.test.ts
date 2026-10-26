import { describe, expect, it } from 'vitest';
import { createSave, InvalidSaveError, readSave } from '../../src/main/services/backup.ts';
import { readZip, sha256Hex, textFile, writeZip } from '../../src/main/services/content/archive.ts';
import * as rules from '../../src/shared/kanban.ts';

const ctx = { now: '2026-10-26T10:00:00.000Z', id: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`; })() };
const bundle = new Uint8Array(Buffer.from('# v2 git bundle\n'));
const packageZip = writeZip([textFile('ticket.en.md', '# SD-214\n')]);

function progress() {
  let state = rules.unlockTicket(rules.createInitialState(ctx), 1, 'a'.repeat(40), ctx);
  state = rules.playerMove(state, 1, 'inProgress', ctx);
  return state;
}

function rebuild(save: Uint8Array, change: (files: ReturnType<typeof readZip>) => ReturnType<typeof readZip>) {
  return writeZip(change(readZip(save)));
}

describe('export and restore manifest', () => {
  const state = progress();
  const save = createSave({ state, bundle, packages: new Map([[1, packageZip]]) }, '0.1.0', ctx.now);

  it('round-trips state, bundle and packages', () => {
    const restored = readSave(save, ctx);
    expect(restored.state).toEqual(state);
    expect(Buffer.from(restored.bundle!).toString()).toBe('# v2 git bundle\n');
    expect(sha256Hex(restored.packages.get(1)!)).toBe(sha256Hex(packageZip));
    expect(restored.manifest).toMatchObject({ format: 'bug-detective-save', formatVersion: 1, appVersion: '0.1.0', schemaVersion: 2 });
    expect(Object.keys(restored.manifest.files).sort()).toEqual(['packages/stage-1.zip', 'state.json', 'workspace.bundle']);
  });

  it('rejects files that are not saves', () => {
    expect(() => readSave(new Uint8Array(Buffer.from('hello')), ctx)).toThrow(InvalidSaveError);
    expect(() => readSave(writeZip([textFile('readme.txt', 'x')]), ctx)).toThrow(/no manifest/);
  });

  it('rejects a manifest with the wrong format or a newer schema', () => {
    const edit = (patch: Record<string, unknown>) =>
      rebuild(save, (files) =>
        files.map((file) =>
          file.path === 'manifest.json'
            ? textFile('manifest.json', JSON.stringify({ ...JSON.parse(Buffer.from(file.data).toString()), ...patch }))
            : file,
        ),
      );
    expect(() => readSave(edit({ format: 'something-else' }), ctx)).toThrow(/manifest is invalid/);
    expect(() => readSave(edit({ formatVersion: 2 }), ctx)).toThrow(/manifest is invalid/);
    expect(() => readSave(edit({ schemaVersion: 99 }), ctx)).toThrow(/newer version/);
  });

  it('rejects damaged or unexpected entries', () => {
    const damaged = rebuild(save, (files) => files.map((file) => (file.path === 'workspace.bundle' ? textFile(file.path, 'changed') : file)));
    expect(() => readSave(damaged, ctx)).toThrow(/workspace.bundle does not match/);
    const missing = rebuild(save, (files) => files.filter((file) => file.path !== 'packages/stage-1.zip'));
    expect(() => readSave(missing, ctx)).toThrow(/packages\/stage-1.zip does not match/);
    const extra = rebuild(save, (files) => [...files, textFile('evil.sh', 'rm -rf /')]);
    expect(() => readSave(extra, ctx)).toThrow(/unexpected file/);
  });

  it('rejects a save whose state is invalid or inconsistent', () => {
    const badState = createSave({ state: { ...progress(), currentTicket: 'one' } as never, bundle, packages: new Map([[1, packageZip]]) }, '0.1.0', ctx.now);
    expect(() => readSave(badState, ctx)).toThrow(/state is invalid/);
    const noBundle = createSave({ state: progress(), bundle: null, packages: new Map([[1, packageZip]]) }, '0.1.0', ctx.now);
    expect(() => readSave(noBundle, ctx)).toThrow(/no workspace repository/);
    const noPackage = createSave({ state: progress(), bundle, packages: new Map() }, '0.1.0', ctx.now);
    expect(() => readSave(noPackage, ctx)).toThrow(/missing the package for ticket 1/);
  });

  it('accepts a save of a new game without a repository', () => {
    const empty = createSave({ state: rules.createInitialState(ctx), bundle: null, packages: new Map() }, '0.1.0', ctx.now);
    expect(readSave(empty, ctx).bundle).toBeNull();
  });
});
