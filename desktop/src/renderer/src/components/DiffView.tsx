import { useTranslation } from 'react-i18next';

interface DiffLine {
  kind: 'add' | 'del' | 'context' | 'hunk';
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

interface DiffFile {
  path: string;
  lines: DiffLine[];
}

/** Parses a unified diff (git diff / reference.patch) into files and lines. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      file = { path: header[2], lines: [] };
      files.push(file);
      continue;
    }
    if (!file || /^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename |old mode|new mode|\\ No newline)/.test(line)) {
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      file.lines.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      file.lines.push({ kind: 'add', text: line.slice(1), newNumber: newLine++ });
    } else if (line.startsWith('-')) {
      file.lines.push({ kind: 'del', text: line.slice(1), oldNumber: oldLine++ });
    } else if (line.startsWith(' ')) {
      file.lines.push({ kind: 'context', text: line.slice(1), oldNumber: oldLine++, newNumber: newLine++ });
    }
  }
  return files;
}

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
