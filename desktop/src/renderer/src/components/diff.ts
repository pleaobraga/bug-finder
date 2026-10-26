/** Parses unified diffs (git diff, reference.patch) for DiffView. */

export interface DiffLine {
  kind: 'add' | 'del' | 'context' | 'hunk';
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

export interface DiffFile {
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
