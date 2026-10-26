import { useTranslation } from 'react-i18next';
import { parseDiff } from './diff.ts';

const ROW = {
  add: 'bg-emerald-500/12 text-emerald-900 dark:text-emerald-200',
  del: 'bg-rose-500/12 text-rose-900 dark:text-rose-200',
  context: 'text-ink',
  hunk: 'bg-brand-500/10 text-muted',
};
const SIGN = { add: '+', del: '−', context: ' ', hunk: '' };

export function DiffView({ diff, testId, emptyText }: { diff: string | null; testId?: string; emptyText?: string }) {
  const { t } = useTranslation();
  const files = diff ? parseDiff(diff) : [];
  if (files.length === 0) {
    return (
      <p className="text-sm text-muted" data-testid={testId}>
        {emptyText ?? t('diff.empty')}
      </p>
    );
  }
  return (
    <div className="space-y-4" data-testid={testId}>
      {files.map((file) => (
        <div key={file.path} className="overflow-hidden rounded-lg border border-line">
          <div className="border-b border-line bg-raised px-3 py-1.5 font-mono text-xs font-medium">{file.path}</div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-xs leading-5">
              <tbody>
                {file.lines.map((line, index) => (
                  <tr key={index} className={ROW[line.kind]} data-kind={line.kind}>
                    <td className="w-10 pr-2 text-right text-muted/70 select-none">{line.oldNumber ?? ''}</td>
                    <td className="w-10 pr-2 text-right text-muted/70 select-none">{line.newNumber ?? ''}</td>
                    <td className="w-4 select-none">{SIGN[line.kind]}</td>
                    <td className="pr-4 whitespace-pre">{line.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
