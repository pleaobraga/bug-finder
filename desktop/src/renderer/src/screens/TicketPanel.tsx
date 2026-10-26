import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Snapshot, TicketContent, WorkspaceStatus } from '@shared/api.ts';
import { findTicket } from '@shared/kanban.ts';
import type { ChatEntry, TicketState } from '@shared/types.ts';
import { api } from '../api.ts';
import { story } from '../content.ts';
import { DiffView } from '../components/DiffView.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { QaCommentView } from '../components/QaComment.tsx';
import { Badge, Button, LogView, Tabs } from '../components/ui.tsx';
import { useToast } from '../toast.tsx';

type Tab = 'ticket' | 'qa' | 'history' | 'senior';

/** Loads the ticket's texts again whenever the ticket, its progress or the language changes. */
function useTicketContent(ticket: TicketState, language: 'en' | 'pt') {
  const [content, setContent] = useState<TicketContent | null>(null);
  const key = `${ticket.ticket}:${ticket.status}:${ticket.hintsRevealed}:${ticket.solutionRevealed}:${language}`;
  useEffect(() => {
    let ignore = false;
    void api.ticketContent(ticket.ticket, language).then((loaded) => {
      if (!ignore) setContent(loaded);
    });
    return () => {
      ignore = true;
    };
  }, [key]);
  return content;
}

function WorkspaceActions({ snapshot, ticket }: { snapshot: Snapshot; ticket: TicketState }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const dockerUp = snapshot.dockerState === 'running';

  const refresh = useCallback(() => {
    if (dockerUp) {
      void api.workspaceStatus().then(setStatus).catch(() => setStatus(null));
    }
  }, [dockerUp]);
  useEffect(refresh, [refresh]);

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await action();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  if (ticket.status === 'done') {
    return <p className="text-sm text-muted">{t('ticket.readOnly')}</p>;
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!dockerUp} busy={busy === 'vscode'} onClick={() => run('vscode', () => api.openVSCode())} data-testid="open-vscode">
          {t('ticket.openVSCode')}
        </Button>
        <Button disabled={!dockerUp} busy={busy === 'browser'} onClick={() => run('browser', () => api.openAppInBrowser())} data-testid="open-browser">
          {t('ticket.openBrowser')}
          {status?.ports && <span className="font-mono text-xs text-muted">:{status.ports.client}</span>}
        </Button>
        {status && !status.devServerUp && (
          <Button variant="ghost" disabled={!dockerUp} busy={busy === 'dev'} onClick={() => run('dev', () => api.startDevServer())} data-testid="start-dev-server">
            {t('ticket.startDevServer')}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted">{t('ticket.vscodeHint')}</p>
      {status && (
        <p className="text-xs text-muted">
          {status.branch && <span className="font-mono">{t('ticket.branch', { branch: status.branch })}</span>}
          {!status.devServerUp && <span className="ml-2">{t('ticket.devServerDown')}</span>}
        </p>
      )}
    </div>
  );
}

function Conversation({ snapshot, ticket, content }: { snapshot: Snapshot; ticket: TicketState; content: TicketContent | null }) {
  const { t } = useTranslation();
  const toast = useToast();
  const people = story(snapshot.state.settings.language).people;
  const senior = people.senior.name;
  const [busy, setBusy] = useState(false);
  const total = snapshot.hintsTotal[ticket.ticket] ?? 3;
  const canAsk = ticket.status === 'inProgress' && ticket.ticket === snapshot.state.currentTicket;

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  const bubble = (entry: ChatEntry, index: number) => {
    const mine = entry.from === 'player';
    let body: ReactNode;
    if (entry.kind === 'question') body = t('ticket.senior.question', { name: senior });
    else if (entry.kind === 'solutionRequest') body = t('ticket.senior.solutionQuestion');
    else if (entry.kind === 'hint') body = content?.hints[entry.hintIndex ?? 0] ?? '…';
    else
      body = (
        <div className="space-y-3">
          <p>{t('ticket.senior.solutionIntro')}</p>
          {content?.solutionMarkdown && <Markdown testId="solution">{content.solutionMarkdown}</Markdown>}
          <DiffView diff={content?.referencePatch ?? null} testId="solution-diff" />
        </div>
      );
    return (
      <div key={index} className={`flex ${mine ? 'justify-end' : 'justify-start'}`} data-testid={`chat-${entry.kind}`}>
        <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${mine ? 'bg-brand-600 text-white' : 'border border-line bg-raised'}`}>
          {!mine && <p className="mb-1 text-xs font-semibold text-muted">{senior}</p>}
          {body}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4" data-testid="conversation">
      <p className="text-sm text-muted">{t('ticket.senior.intro', { name: senior })}</p>
      <div className="space-y-3">{ticket.conversation.map(bubble)}</div>
      {canAsk ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          {ticket.hintsRevealed < total ? (
            <Button variant="primary" busy={busy} onClick={() => act(() => api.askSenior(ticket.ticket))} data-testid="ask-hint">
              {t('ticket.senior.ask')}
            </Button>
          ) : !ticket.solutionRevealed ? (
            <>
              <span className="text-sm text-muted">{t('ticket.senior.noMoreHints')}</span>
              <Button variant="primary" busy={busy} onClick={() => act(() => api.revealSolution(ticket.ticket))} data-testid="reveal-solution">
                {t('ticket.senior.askSolution')}
              </Button>
            </>
          ) : null}
          <span className="ml-auto text-xs text-muted" data-testid="hints-used">
            {t('ticket.hintsUsed', { used: ticket.hintsRevealed, total })}
          </span>
        </div>
      ) : (
        ticket.status !== 'done' && <p className="text-sm text-muted">{t('ticket.senior.onlyInProgress')}</p>
      )}
    </div>
  );
}

function History({ ticket, snapshot }: { ticket: TicketState; snapshot: Snapshot }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'pt' ? 'pt-BR' : 'en-US';
  const activity = snapshot.state.activity.filter((entry) => entry.ticket === ticket.ticket);
  const column = (value: string) => t(`board.columns.${value}`);
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-sm font-semibold">{t('ticket.attemptHistory')}</h3>
        {ticket.attempts.length === 0 ? (
          <p className="text-sm text-muted">{t('ticket.noAttempts')}</p>
        ) : (
          <ol className="space-y-2" data-testid="attempts">
            {ticket.attempts.map((attempt) => {
              const passed = attempt.result.tests.filter((test) => test.status === 'passed').length;
              const failed = attempt.result.tests.filter((test) => test.status === 'failed').length;
              return (
                <li key={attempt.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm" data-testid="attempt">
                  <span className="font-medium">{t('ticket.attempt', { number: attempt.number })}</span>
                  <Badge tone={attempt.result.status === 'passed' ? 'ok' : 'danger'}>
                    {t(`ticket.attemptResult.${attempt.result.status}`)}
                    {attempt.result.status !== 'passed' && ` · ${t('qa.gate', { gate: attempt.result.gate })}`}
                  </Badge>
                  <span className="text-muted">{t('ticket.testsSummary', { passed, failed })}</span>
                  {attempt.branch && <span className="font-mono text-xs text-muted">{attempt.branch}</span>}
                  <time className="ml-auto text-xs text-muted">{new Date(attempt.finishedAt).toLocaleString(locale)}</time>
                </li>
              );
            })}
          </ol>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold">{t('ticket.activity')}</h3>
        <ol className="space-y-1.5 text-sm" data-testid="activity">
          {activity.map((entry, index) => (
            <li key={index} className="flex gap-3" data-testid="activity-entry">
              <time className="w-40 shrink-0 text-xs text-muted">{new Date(entry.at).toLocaleString(locale)}</time>
              <span>
                {entry.from ? t('ticket.transition', { from: column(entry.from), to: column(entry.to) }) : t('ticket.created', { to: column(entry.to) })}
                <span className="ml-2 text-xs text-muted">({t(`ticket.actor.${entry.actor}`)})</span>
              </span>
            </li>
          ))}
        </ol>
      </section>
      <p className="text-sm text-muted">
        {t('ticket.hintsUsed', { used: ticket.hintsRevealed, total: snapshot.hintsTotal[ticket.ticket] ?? 3 })}
        {ticket.solutionRevealed && ` · ${t('ticket.solutionRevealed')}`}
      </p>
    </div>
  );
}

export function TicketPanel({
  snapshot,
  ticketNumber,
  onClose,
  onOpenReview,
}: {
  snapshot: Snapshot;
  ticketNumber: number;
  onClose: () => void;
  onOpenReview: () => void;
}) {
  const { t } = useTranslation();
  const ticket = findTicket(snapshot.state, ticketNumber)!;
  const language = snapshot.state.settings.language;
  const content = useTicketContent(ticket, language);
  const [tab, setTab] = useState<Tab>('ticket');
  const senior = story(language).people.senior.name;
  const qaRunning = ticket.status === 'inQa';

  // Jump to the QA tab when a QA run finishes with a new comment.
  const commentCount = ticket.comments.length;
  const [seenComments, setSeenComments] = useState(commentCount);
  useEffect(() => {
    if (commentCount > seenComments) {
      setTab('qa');
      setSeenComments(commentCount);
    }
  }, [commentCount, seenComments]);

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-slate-950/30" onClick={onClose} data-testid="ticket-panel-backdrop">
      <aside
        className="flex h-full w-panel max-w-full flex-col border-l border-line bg-canvas shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        data-testid="ticket-panel"
        aria-label={snapshot.titles[ticket.ticket]?.[language]}
      >
        <header className="space-y-3 border-b border-line bg-surface p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Badge tone="brand">{t(`board.columns.${ticket.status}`)}</Badge>
              <h2 className="mt-2 text-lg font-semibold" data-testid="ticket-title">
                {snapshot.titles[ticket.ticket]?.[language]}
              </h2>
            </div>
            <Button variant="ghost" onClick={onClose} aria-label={t('common.close')} data-testid="close-panel">
              ✕
            </Button>
          </div>
          <WorkspaceActions snapshot={snapshot} ticket={ticket} />
          {(ticket.status === 'codeReview' || ticket.status === 'done') && (
            <Button variant="primary" onClick={onOpenReview} data-testid="open-review">
              {t('ticket.openReview')}
            </Button>
          )}
        </header>
        <div className="px-5 pt-3">
          <Tabs<Tab>
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'ticket', label: t('ticket.tabs.ticket') },
              { id: 'qa', label: t('ticket.tabs.qa'), badge: ticket.comments.length > 0 ? <Badge>{ticket.comments.length}</Badge> : undefined },
              { id: 'history', label: t('ticket.tabs.history') },
              { id: 'senior', label: t('ticket.tabs.senior', { name: senior }) },
            ]}
          />
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'ticket' && content && <Markdown testId="ticket-markdown">{content.ticketMarkdown}</Markdown>}
          {tab === 'qa' && (
            <div className="space-y-3" data-testid="qa-comments">
              {qaRunning && (
                <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950" data-testid="qa-running">
                  <p>{t('qa.running')}</p>
                  {snapshot.busy === 'qa' && <LogView lines={snapshot.log} />}
                </div>
              )}
              {ticket.comments.length === 0 && !qaRunning && <p className="text-sm text-muted">{t('ticket.noComments')}</p>}
              {[...ticket.comments].reverse().map((comment) => (
                <QaCommentView key={comment.id} comment={comment} />
              ))}
            </div>
          )}
          {tab === 'history' && <History ticket={ticket} snapshot={snapshot} />}
          {tab === 'senior' && <Conversation snapshot={snapshot} ticket={ticket} content={content} />}
        </div>
      </aside>
    </div>
  );
}
