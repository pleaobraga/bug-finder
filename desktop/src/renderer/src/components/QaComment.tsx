import { useTranslation } from 'react-i18next';
import { qaMessage } from '@shared/qaMessages.ts';
import type { QaComment as Comment } from '@shared/types.ts';
import { Badge } from './ui.tsx';

const TONE = {
  gate1Failed: 'danger',
  gate2Failed: 'danger',
  timeout: 'danger',
  passed: 'ok',
  interrupted: 'warn',
  error: 'warn',
  branchWarning: 'warn',
  branchWarningDetached: 'warn',
} as const;

export function QaCommentView({ comment }: { comment: Comment }) {
  const { t, i18n } = useTranslation();
  const message = qaMessage(comment);
  return (
    <article className="rounded-lg border border-line bg-surface p-4" data-testid="qa-comment" data-kind={comment.kind}>
      <header className="mb-2 flex items-center gap-2 text-xs text-muted">
        <Badge tone={TONE[message.key]}>{message.gate ? t('qa.gate', { gate: message.gate }) : 'QA'}</Badge>
        <time>{new Date(comment.at).toLocaleString(i18n.language === 'pt' ? 'pt-BR' : 'en-US')}</time>
      </header>
      <p className="text-sm">{t(`qa.comment.${message.key}`, message.params)}</p>
      {message.failing.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-muted">{t('qa.failingTests')}</p>
          <ul className="mt-1 space-y-2">
            {message.failing.map((test) => (
              <li key={test.name} data-testid="qa-failing-test">
                <p className="text-sm font-medium">• {test.name}</p>
                {test.error && (
                  <pre className="mt-1 overflow-x-auto rounded bg-raised p-2 font-mono text-xs whitespace-pre-wrap text-muted">{test.error}</pre>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {message.unfinished.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-muted">{t('qa.unfinishedTests')}</p>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {message.unfinished.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}
