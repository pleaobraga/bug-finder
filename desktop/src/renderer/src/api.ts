import { useEffect, useState } from 'react';
import type { BugDetectiveApi, Snapshot } from '@shared/api.ts';

declare global {
  interface Window {
    bugDetective: BugDetectiveApi;
  }
}

export const api = window.bugDetective;

/** The latest snapshot from the main process, kept up to date by its change events. */
export function useSnapshot(): Snapshot | null {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    const unsubscribe = api.onSnapshot(setSnapshot);
    void api.snapshot().then(setSnapshot);
    return unsubscribe;
  }, []);
  return snapshot;
}

/** Splits "[code] message" errors from the preload bridge. */
export function errorInfo(error: unknown): { code: string; message: string } {
  const text = error instanceof Error ? error.message : String(error);
  const match = /\[([A-Za-z]+)\]\s*([\s\S]*)$/.exec(text);
  return match ? { code: match[1], message: match[2] } : { code: 'failed', message: text };
}
