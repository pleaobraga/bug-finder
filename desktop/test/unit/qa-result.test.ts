import { describe, expect, it } from 'vitest';
import { outerTimeoutResult, parseQaResult, QaInfrastructureError } from '../../src/main/services/qa.ts';
import { commentForResult } from '../../src/shared/kanban.ts';
import { qaMessage, trimError } from '../../src/shared/qaMessages.ts';
import type { QaComment } from '../../src/shared/types.ts';

const ctx = { now: '2026-10-26T10:00:00.000Z', id: () => 'c1' };

// Shaped exactly like `npm run qa -- --json` output.
const gate2Failure = {
  ticket: 1,
  gate: 2,
  status: 'failed',
  message: 'Gate 2 failed: the reported bug is still unresolved.',
  tests: [
    { name: 'client/src/pages/TicketList.test.tsx > TicketList > renders the tickets', status: 'passed' },
    { name: 'Ticket 1: details follow Previous and Next > Next shows the next ticket', status: 'failed', error: 'expect(locator).toHaveText(expected) failed' },
    { name: 'Ticket 1: details follow Previous and Next > Previous shows the previous ticket', status: 'failed' },
  ],
  durationMs: 36612,
};

describe('parseQaResult', () => {
  it('parses the CLI JSON output', () => {
    const result = parseQaResult(JSON.stringify(gate2Failure), 1);
    expect(result.status).toBe('failed');
    expect(result.tests).toHaveLength(3);
  });

  it('rejects malformed, incomplete or mismatched results', () => {
    expect(() => parseQaResult('not json', 1)).toThrow(QaInfrastructureError);
    expect(() => parseQaResult(JSON.stringify({ ...gate2Failure, status: 'maybe' }), 1)).toThrow(QaInfrastructureError);
    expect(() => parseQaResult(JSON.stringify({ ...gate2Failure, gate: 3 }), 1)).toThrow(QaInfrastructureError);
    expect(() => parseQaResult(JSON.stringify({ ...gate2Failure, tests: undefined }), 1)).toThrow(QaInfrastructureError);
    expect(() => parseQaResult(JSON.stringify(gate2Failure), 2)).toThrow(/expected 2/);
  });

  it('builds a timeout result when the container had to be stopped', () => {
    expect(outerTimeoutResult(3, 180, 270000)).toMatchObject({ ticket: 3, status: 'timeout', tests: [] });
  });
});

describe('QA comment and message selection', () => {
  it('names the gate and lists failing tests with their errors', () => {
    const comment = commentForResult(parseQaResult(JSON.stringify(gate2Failure), 1), 'a1', 180, ctx);
    expect(comment).toMatchObject({ kind: 'gate2Failed', attemptId: 'a1' });
    const message = qaMessage(comment);
    expect(message).toMatchObject({ key: 'gate2Failed', gate: 2, params: { count: 2 } });
    expect(message.failing.map((test) => test.name)).toEqual([
      'Ticket 1: details follow Previous and Next > Next shows the next ticket',
      'Ticket 1: details follow Previous and Next > Previous shows the previous ticket',
    ]);
    expect(message.failing[0].error).toContain('toHaveText');
  });

  it('selects the Gate 1 template', () => {
    const comment = commentForResult({ ...gate2Failure, gate: 1, status: 'failed' } as never, 'a1', 180, ctx);
    expect(qaMessage(comment)).toMatchObject({ key: 'gate1Failed', gate: 1 });
  });

  it('selects the timeout template with the limit and unfinished tests', () => {
    const comment = commentForResult(
      { ...gate2Failure, status: 'timeout', tests: [{ name: 'slow test', status: 'unfinished' }] } as never,
      'a1',
      240,
      ctx,
    );
    expect(qaMessage(comment)).toMatchObject({ key: 'timeout', params: { seconds: 240 }, unfinished: ['slow test'] });
  });

  it('selects templates for system comments', () => {
    const base = { id: 'x', at: ctx.now };
    expect(qaMessage({ ...base, kind: 'passed' })).toMatchObject({ key: 'passed' });
    expect(qaMessage({ ...base, kind: 'interrupted' })).toMatchObject({ key: 'interrupted' });
    expect(qaMessage({ ...base, kind: 'error', detail: 'Docker stopped' })).toMatchObject({ key: 'error', params: { detail: 'Docker stopped' } });
    expect(qaMessage({ ...base, kind: 'branchWarning', branch: 'main' } as QaComment)).toMatchObject({ key: 'branchWarning', params: { branch: 'main' } });
    expect(qaMessage({ ...base, kind: 'branchWarning', branch: null } as QaComment)).toMatchObject({ key: 'branchWarningDetached' });
  });

  it('trims long errors', () => {
    const error = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const trimmed = trimError(error)!;
    expect(trimmed.split('\n')).toHaveLength(13);
    expect(trimmed.endsWith('…')).toBe(true);
  });
});
