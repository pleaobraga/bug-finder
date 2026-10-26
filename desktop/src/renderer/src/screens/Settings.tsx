import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SaveSummary, Snapshot } from '@shared/api.ts';
import { LANGUAGES, MAX_QA_TIMEOUT_SECONDS, MIN_QA_TIMEOUT_SECONDS, THEMES } from '@shared/types.ts';
import { api } from '../api.ts';
import { Badge, Button, Card, LogView, Modal, SectionTitle } from '../components/ui.tsx';
import { useToast } from '../toast.tsx';

const LANGUAGE_NAMES = { en: 'English', pt: 'Português (Brasil)' };

export function Settings({ snapshot }: { snapshot: Snapshot }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { settings } = snapshot.state;
  const [timeout, setTimeoutValue] = useState(String(settings.qaTimeoutSeconds));
  const [pending, setPending] = useState<{ token: string; summary: SaveSummary } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (id: string, action: () => Promise<void>) => {
    setBusy(id);
    try {
      await action();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(null);
    }
  };

  const check = (id: string) => snapshot.prerequisites?.checks.find((item) => item.id === id);
  const saveTimeout = () => {
    const value = Number(timeout);
    if (Number.isInteger(value) && value >= MIN_QA_TIMEOUT_SECONDS && value <= MAX_QA_TIMEOUT_SECONDS) {
      void api.updateSettings({ qaTimeoutSeconds: value }).catch(toast.error);
    } else {
      setTimeoutValue(String(settings.qaTimeoutSeconds));
    }
  };

  return (
    <div className="max-w-3xl space-y-6 p-8" data-testid="settings">
      <h1 className="text-2xl font-semibold">{t('settings.title')}</h1>

      <Card className="space-y-5">
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm font-medium">{t('settings.language')}</span>
          <select
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm"
            value={settings.language}
            onChange={(event) => void api.updateSettings({ language: event.target.value as 'en' | 'pt' })}
            data-testid="language-select"
          >
            {LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {LANGUAGE_NAMES[language]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm font-medium">{t('settings.theme')}</span>
          <select
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm"
            value={settings.theme}
            onChange={(event) => void api.updateSettings({ theme: event.target.value as 'system' })}
            data-testid="theme-select"
          >
            {THEMES.map((theme) => (
              <option key={theme} value={theme}>
                {t(`settings.themes.${theme}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm font-medium">{t('settings.qaTimeout')}</span>
            <span className="block text-xs text-muted">{t('settings.qaTimeoutHelp')}</span>
          </span>
          <input
            type="number"
            min={MIN_QA_TIMEOUT_SECONDS}
            max={MAX_QA_TIMEOUT_SECONDS}
            className="w-28 rounded-lg border border-line bg-surface px-3 py-2 text-sm"
            value={timeout}
            onChange={(event) => setTimeoutValue(event.target.value)}
            onBlur={saveTimeout}
            data-testid="qa-timeout"
          />
        </label>
      </Card>

      <Card>
        <SectionTitle>{t('settings.status')}</SectionTitle>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted">{t('settings.docker')}</dt>
          <dd>
            <Badge tone={snapshot.dockerState === 'running' ? 'ok' : 'danger'}>{t(`checklist.docker.${snapshot.dockerState ?? 'notRunning'}`)}</Badge>
          </dd>
          <dt className="text-muted">{t('settings.vscode')}</dt>
          <dd className="space-x-2">
            <Badge tone={check('vscode')?.status === 'ok' ? 'ok' : 'danger'}>{t(`checklist.status.${check('vscode')?.status ?? 'missing'}`)}</Badge>
            <Badge tone={check('devcontainers')?.status === 'ok' ? 'ok' : 'danger'}>Dev Containers</Badge>
          </dd>
        </dl>
        <Button className="mt-4" onClick={() => run('check', async () => void (await api.checkPrerequisites()))} busy={busy === 'check'}>
          {t('common.checkAgain')}
        </Button>
      </Card>

      <Card>
        <SectionTitle>{t('settings.progress')}</SectionTitle>
        <p className="text-sm text-muted">{t('settings.exportHelp')}</p>
        <div className="mt-4 flex gap-2">
          <Button
            variant="primary"
            busy={busy === 'export' || snapshot.busy === 'exporting'}
            disabled={snapshot.busy !== null}
            onClick={() =>
              run('export', async () => {
                const result = await api.exportProgress();
                if (result.saved) toast.info(t('settings.exported', { path: result.path }));
              })
            }
            data-testid="export-progress"
          >
            {t('settings.export')}
          </Button>
          <Button
            busy={busy === 'inspect' || snapshot.busy === 'restoring'}
            disabled={snapshot.busy !== null}
            onClick={() => run('inspect', async () => setPending(await api.inspectSave()))}
            data-testid="restore-progress"
          >
            {t('settings.restore')}
          </Button>
        </div>
        {snapshot.busy === 'restoring' && (
          <div className="mt-3">
            <LogView lines={snapshot.log} />
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>{t('settings.about')}</SectionTitle>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted">{t('app.name')}</dt>
          <dd>{snapshot.appVersion}</dd>
          <dt className="text-muted">{t('settings.versions')}</dt>
          <dd className="font-mono text-xs">
            Electron {snapshot.versions.electron} · Node {snapshot.versions.node} · Chromium {snapshot.versions.chrome}
          </dd>
          <dt className="text-muted">{t('settings.contentSource')}</dt>
          <dd className="font-mono text-xs break-all">{snapshot.contentSource}</dd>
        </dl>
      </Card>

      {pending && (
        <Modal title={t('settings.restoreTitle')} onClose={() => setPending(null)}>
          <p className="text-sm">
            {t('settings.restoreSummary', {
              file: pending.summary.fileName,
              date: new Date(pending.summary.createdAt).toLocaleString(i18n.language === 'pt' ? 'pt-BR' : 'en-US'),
              done: pending.summary.ticketsDone,
            })}
          </p>
          {pending.summary.overwritesProgress && (
            <p className="mt-3 rounded-lg bg-amber-100 p-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100" data-testid="restore-warning">
              {t('settings.restoreWarning')}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => setPending(null)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const { token } = pending;
                setPending(null);
                void run('restore', async () => {
                  await api.restoreProgress(token);
                  toast.info(t('settings.restored'));
                });
              }}
              data-testid="confirm-restore"
            >
              {t('settings.restoreConfirm')}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
