/**
 * Chooses the predefined QA comment template for a comment. The renderer translates the key
 * with i18next; the texts match the SupportDesk QA CLI's own messages (qa/messages.ts).
 */
import type { QaComment } from './types.ts';

export interface QaMessage {
  /** i18n key under "qa.comment". */
  key: 'gate1Failed' | 'gate2Failed' | 'timeout' | 'passed' | 'interrupted' | 'error' | 'branchWarning' | 'branchWarningDetached';
  params: Record<string, string | number>;
  /** Failing tests to list under the message, with their errors. */
  failing: { name: string; error?: string }[];
  /** Tests that had not finished when QA timed out. */
  unfinished: string[];
  /** Which gate the comment is about, if any. */
  gate: 1 | 2 | null;
}

const MAX_ERROR_LINES = 12;

/** Keeps the end of long errors, where assertion details usually are. */
export function trimError(error: string | undefined): string | undefined {
  if (!error) {
    return undefined;
  }
  const lines = error.trimEnd().split('\n');
  return lines.length > MAX_ERROR_LINES ? lines.slice(0, MAX_ERROR_LINES).join('\n') + '\n…' : lines.join('\n');
}

export function qaMessage(comment: QaComment): QaMessage {
  const failing = (comment.failing ?? []).map((test) => ({ name: test.name, error: trimError(test.error) }));
  const unfinished = comment.unfinished ?? [];
  switch (comment.kind) {
    case 'gate1Failed':
      return { key: 'gate1Failed', params: { count: failing.length }, failing, unfinished, gate: 1 };
    case 'gate2Failed':
      return { key: 'gate2Failed', params: { count: failing.length }, failing, unfinished, gate: 2 };
    case 'timeout':
      return { key: 'timeout', params: { seconds: comment.timeoutSeconds ?? 0 }, failing, unfinished, gate: null };
    case 'passed':
      return { key: 'passed', params: {}, failing: [], unfinished: [], gate: 2 };
    case 'interrupted':
      return { key: 'interrupted', params: {}, failing: [], unfinished: [], gate: null };
    case 'error':
      return { key: 'error', params: { detail: comment.detail ?? '' }, failing: [], unfinished: [], gate: null };
    case 'branchWarning':
      return comment.branch
        ? { key: 'branchWarning', params: { branch: comment.branch }, failing: [], unfinished: [], gate: null }
        : { key: 'branchWarningDetached', params: {}, failing: [], unfinished: [], gate: null };
  }
}
