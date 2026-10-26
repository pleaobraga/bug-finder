import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Snapshot } from '@shared/api.ts';
import { TICKET_COUNT } from '@shared/types.ts';
import type { InboxMessage } from '@shared/types.ts';
import { api } from '../api.ts';
import { story } from '../content.ts';
import { Markdown } from '../components/Markdown.tsx';
import { Badge, Button, Card, LogView, SectionTitle, StatusIcon } from '../components/ui.tsx';
import { useToast } from '../toast-context.ts';

export function EnvironmentPanel({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [showLog, setShowLog] = useState(false);
  const environment = snapshot.environment;
  const installing = snapshot.busy === 'installing';
  if (!environment || (environment.ready && !installing)) {
    return null;
  }
  return (
    <Card className="border-amber-300 dark:border-amber-800" data-testid="environment-panel">
      <h2 className="font-semibold">{t('environment.title')}</h2>
      <p className="mt-1 text-sm text-muted">{t('environment.intro')}</p>
      <ul className="mt-4 space-y-2">
        {environment.items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 text-sm" data-testid={`env-${item.id}`} data-ready={item.ready}>
            <StatusIcon status={item.ready ? 'ok' : installing ? 'pending' : 'missing'} />
            {t(`environment.items.${item.id}`)}
          </li>
        ))}
      </ul>
      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="primary"
          busy={installing}
          disabled={snapshot.busy !== null && !installing}
          onClick={() => api.installEnvironment().catch(toast.error)}
          data-testid="install-environment"
        >
          {installing ? t('environment.installing') : t('environment.install')}
        </Button>
        {snapshot.log.length > 0 && (
          <Button variant="ghost" onClick={() => setShowLog(!showLog)}>
            {showLog ? t('common.hideLog') : t('common.showLog')}
          </Button>
        )}
      </div>
      {(showLog || installing) && snapshot.log.length > 0 && (
        <div className="mt-3">
          <LogView lines={snapshot.log} />
        </div>
      )}
    </Card>
  );
}

function InboxItem({ message, language, onOpen, open }: { message: InboxMessage; language: 'en' | 'pt'; onOpen: () => void; open: boolean }) {
  const { i18n } = useTranslation();
  const content = story(language);
  const text =
    message.kind === 'welcome'
      ? content.messages.welcome
      : message.kind === 'completion'
        ? content.messages.completion
        : content.messages.assignments[String(message.ticket) as '1' | '2' | '3' | '4'];
  return (
    <li className="border-b border-line last:border-0" data-testid="inbox-message" data-kind={message.kind}>
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 py-3 text-left">
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${message.read ? 'bg-transparent' : 'bg-brand-500'}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm ${message.read ? '' : 'font-semibold'}`}>{text.subject}</span>
          <span className="block text-xs text-muted">
            {content.people.manager.name} · {new Date(message.at).toLocaleDateString(i18n.language === 'pt' ? 'pt-BR' : 'en-US')}
          </span>
        </span>
      </button>
      {open && (
        <div className="pb-4 pl-5">
          <Markdown testId="inbox-body">{text.body}</Markdown>
        </div>
      )}
    </li>
  );
}

export function Dashboard({ snapshot, onOpenBoard }: { snapshot: Snapshot; onOpenBoard: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { state } = snapshot;
  const language = state.settings.language;
  const content = story(language);
  const [openMessage, setOpenMessage] = useState<string | null>(state.inbox.at(-1)?.id ?? null);
  const done = state.tickets.filter((ticket) => ticket.status === 'done').length;
  const current = state.currentTicket !== null ? state.tickets.find((ticket) => ticket.ticket === state.currentTicket) : undefined;
  const unlocking = snapshot.busy === 'unlocking';
  const dockerDown = snapshot.dockerState !== 'running';
  const needsEnvironment = snapshot.environment !== null && !snapshot.environment.items.find((item) => item.id === 'workspaceImage')?.ready;

  const open = (message: InboxMessage) => {
    setOpenMessage(openMessage === message.id ? null : message.id);
    if (!message.read) {
      void api.markInboxRead(message.id);
    }
  };

  return (
    <div className="grid gap-6 p-8 xl:grid-cols-[minmax(0,1fr)_26rem]" data-testid="dashboard">
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">{t('dashboard.welcome', { company: content.company.name })}</h1>
          <p className="mt-1 text-muted">{content.company.tagline}</p>
        </header>

        <EnvironmentPanel snapshot={snapshot} />

        <Card>
          <SectionTitle>{t('dashboard.status')}</SectionTitle>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm" data-testid="tickets-done">
                {t('dashboard.ticketsDone', { count: done, total: TICKET_COUNT })}
              </p>
              <div className="mt-2 flex gap-1.5" aria-hidden>
                {Array.from({ length: TICKET_COUNT }, (_, index) => (
                  <span key={index} className={`h-1.5 w-10 rounded-full ${index < done ? 'bg-col-done' : index < state.tickets.length ? 'bg-col-progress' : 'bg-raised'}`} />
                ))}
              </div>
              <p className="mt-3 text-sm text-muted">
                {t('dashboard.current')}:{' '}
                {current ? (
                  <span className="text-ink">
                    {snapshot.titles[current.ticket]?.[language]} <Badge tone="brand">{t(`board.columns.${current.status}`)}</Badge>
                  </span>
                ) : (
                  t('dashboard.noTicket')
                )}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              {snapshot.nextTicket !== null ? (
                <Button
                  variant="primary"
                  busy={unlocking}
                  disabled={dockerDown || needsEnvironment || (snapshot.busy !== null && !unlocking)}
                  onClick={() => api.nextAssignment().then(onOpenBoard).catch(toast.error)}
                  data-testid="next-assignment"
                >
                  {unlocking ? t('dashboard.unlocking') : t('dashboard.nextAssignment')}
                </Button>
              ) : (
                <p className="text-sm text-muted">{done === TICKET_COUNT ? t('dashboard.allDone') : t('dashboard.finishFirst')}</p>
              )}
              {state.tickets.length > 0 && (
                <Button variant="ghost" onClick={onOpenBoard}>
                  {t('dashboard.openBoard')} →
                </Button>
              )}
            </div>
          </div>
          {unlocking && snapshot.log.length > 0 && (
            <div className="mt-4">
              <LogView lines={snapshot.log} />
            </div>
          )}
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <SectionTitle>{content.company.name}</SectionTitle>
            <p className="text-sm leading-relaxed">{content.company.about}</p>
          </Card>
          <Card>
            <SectionTitle>
              {t('dashboard.client')}: {content.client.name}
            </SectionTitle>
            <p className="text-sm leading-relaxed">{content.client.about}</p>
            <p className="mt-2 text-sm text-muted">{content.client.contacts}</p>
          </Card>
          <Card className="md:col-span-2">
            <SectionTitle>
              {t('dashboard.project')}: {content.project.name}
            </SectionTitle>
            <p className="text-sm leading-relaxed">{content.project.about}</p>
          </Card>
        </div>
      </div>

      <Card className="self-start">
        <SectionTitle>{t('dashboard.inbox')}</SectionTitle>
        <ul data-testid="inbox">
          {[...state.inbox].reverse().map((message) => (
            <InboxItem key={message.id} message={message} language={language} open={openMessage === message.id} onOpen={() => open(message)} />
          ))}
        </ul>
      </Card>
    </div>
  );
}
