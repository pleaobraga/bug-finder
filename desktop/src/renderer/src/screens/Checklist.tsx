import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CheckResult, ExternalLink, Snapshot } from '@shared/api.ts';
import { api } from '../api.ts';
import { Button, Card, StatusIcon } from '../components/ui.tsx';
import { useToast } from '../toast-context.ts';

const LINKS: Record<CheckResult['id'], ExternalLink> = {
  docker: 'dockerDesktop',
  wsl: 'wsl',
  vscode: 'vscode',
  devcontainers: 'devContainers',
};

export function Checklist({ snapshot, onContinue }: { snapshot: Snapshot; onContinue: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const report = snapshot.prerequisites;

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await action();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-6 p-8" data-testid="checklist">
      <div>
        <p className="text-sm font-semibold text-brand-600">{t('app.name')}</p>
        <h1 className="mt-1 text-2xl font-semibold">{t('checklist.title')}</h1>
        <p className="mt-2 text-muted">{t('checklist.intro')}</p>
      </div>
      <Card className="divide-y divide-line p-0">
        {(report?.checks ?? []).map((check) => {
          const reason = check.status === 'ok' ? 'ok' : (check.reason ?? 'notFound');
          return (
            <div key={check.id} className="flex gap-4 p-5" data-testid={`check-${check.id}`} data-status={check.status}>
              <StatusIcon status={check.status} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="font-medium">{t(`checklist.${check.id}.title`)}</h2>
                  <span className="text-xs text-muted">{t(`checklist.status.${check.status}`)}</span>
                </div>
                <p className="mt-1 text-sm text-muted">{t(`checklist.${check.id}.${reason}`)}</p>
                {check.status !== 'ok' && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {check.id === 'docker' && check.reason !== 'notInstalled' && (
                      <Button
                        variant="primary"
                        busy={busy === 'docker' || snapshot.busy === 'startingDocker'}
                        onClick={() => run('docker', () => api.startDocker())}
                        data-testid="start-docker"
                      >
                        {t('checklist.docker.start')}
                      </Button>
                    )}
                    {check.id === 'devcontainers' && snapshot.prerequisites?.checks.find((c) => c.id === 'vscode')?.status === 'ok' && (
                      <Button
                        variant="primary"
                        busy={busy === 'devcontainers'}
                        onClick={() => run('devcontainers', () => api.installDevContainers())}
                        data-testid="install-devcontainers"
                      >
                        {t('checklist.devcontainers.install')}
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => void api.openExternal(LINKS[check.id])}>
                      {t('common.learnMore')} ↗
                    </Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </Card>
      <div className="flex items-center justify-between">
        <Button busy={busy === 'check'} onClick={() => run('check', () => api.checkPrerequisites())} data-testid="check-again">
          {t('common.checkAgain')}
        </Button>
        <div className="flex items-center gap-3">
          {report?.allOk && <span className="text-sm text-ok">{t('checklist.allOk')}</span>}
          <Button variant="primary" disabled={!report?.allOk} onClick={onContinue} data-testid="start-playing">
            {t('checklist.continue')}
          </Button>
        </div>
      </div>
    </main>
  );
}

export function DockerBanner({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation();
  const toast = useToast();
  if (snapshot.dockerState === 'running' || snapshot.dockerState === null) {
    return null;
  }
  const starting = snapshot.dockerState === 'starting' || snapshot.busy === 'startingDocker';
  return (
    <div className="flex items-center justify-between gap-4 bg-amber-100 px-6 py-2.5 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100" role="alert" data-testid="docker-banner">
      <span>{starting ? t('banner.dockerStarting') : t('banner.dockerStopped')}</span>
      {!starting && snapshot.dockerState !== 'notInstalled' && (
        <Button onClick={() => api.startDocker().catch(toast.error)}>{t('banner.startDocker')}</Button>
      )}
    </div>
  );
}
