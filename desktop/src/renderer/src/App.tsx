import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Snapshot } from '@shared/api.ts';
import { useSnapshot } from './api.ts';
import { Spinner } from './components/ui.tsx';
import { Board } from './screens/Board.tsx';
import { Checklist, DockerBanner } from './screens/Checklist.tsx';
import { CodeReview } from './screens/CodeReview.tsx';
import { Dashboard } from './screens/Dashboard.tsx';
import { Settings } from './screens/Settings.tsx';
import { TicketPanel } from './screens/TicketPanel.tsx';

type View = 'dashboard' | 'board' | 'settings' | 'review';

function useThemeAndLanguage(snapshot: Snapshot | null) {
  const { i18n } = useTranslation();
  const language = snapshot?.state.settings.language;
  const theme = snapshot?.state.settings.theme;
  useEffect(() => {
    if (language && i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
    document.documentElement.lang = language === 'pt' ? 'pt-BR' : 'en';
  }, [i18n, language]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme !== 'light' && media.matches));
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}

export function App() {
  const { t } = useTranslation();
  const snapshot = useSnapshot();
  const [view, setView] = useState<View>('dashboard');
  const [openTicket, setOpenTicket] = useState<number | null>(null);
  const [reviewTicket, setReviewTicket] = useState<number | null>(null);
  const [checklistDone, setChecklistDone] = useState(false);
  useThemeAndLanguage(snapshot);

  // The checklist is skipped when everything already passes and a game is in progress. Once
  // passed, it stays passed for the session (state adjusted during render, not in an effect).
  const allOk = snapshot?.prerequisites?.allOk ?? false;
  if (allOk && !checklistDone && snapshot?.state.tickets.length) {
    setChecklistDone(true);
  }

  if (!snapshot || !snapshot.prerequisites) {
    return (
      <div className="flex h-full items-center justify-center gap-3 text-muted">
        <Spinner /> {t('common.working')}
      </div>
    );
  }
  if (!checklistDone) {
    return <Checklist snapshot={snapshot} onContinue={() => setChecklistDone(true)} />;
  }

  const nav: { id: View; label: string }[] = [
    { id: 'dashboard', label: t('nav.dashboard') },
    { id: 'board', label: t('nav.board') },
    { id: 'settings', label: t('nav.settings') },
  ];
  const unread = snapshot.state.inbox.filter((message) => !message.read).length;

  return (
    <div className="flex h-full">
      <nav className="flex w-sidebar shrink-0 flex-col border-r border-line bg-surface p-4" aria-label="Main">
        <div className="mb-6 flex items-center gap-2 px-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand-600 font-mono text-sm font-bold text-white">BD</span>
          <span className="font-semibold">{t('app.name')}</span>
        </div>
        {nav.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setView(item.id)}
            data-testid={`nav-${item.id}`}
            className={`mb-1 flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-medium ${
              view === item.id || (view === 'review' && item.id === 'board') ? 'bg-brand-500/10 text-brand-700 dark:text-brand-400' : 'text-muted hover:bg-raised hover:text-ink'
            }`}
          >
            {item.label}
            {item.id === 'dashboard' && unread > 0 && (
              <span className="rounded-full bg-brand-600 px-1.5 text-xs text-white" data-testid="unread-count">
                {unread}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <DockerBanner snapshot={snapshot} />
        <main className="min-h-0 flex-1 overflow-y-auto">
          {view === 'dashboard' && <Dashboard snapshot={snapshot} onOpenBoard={() => setView('board')} />}
          {view === 'board' && <Board snapshot={snapshot} onOpenTicket={setOpenTicket} />}
          {view === 'settings' && <Settings snapshot={snapshot} />}
          {view === 'review' && reviewTicket !== null && (
            <CodeReview snapshot={snapshot} ticketNumber={reviewTicket} onBack={() => setView('board')} />
          )}
        </main>
      </div>
      {openTicket !== null && view !== 'review' && (
        <TicketPanel
          snapshot={snapshot}
          ticketNumber={openTicket}
          onClose={() => setOpenTicket(null)}
          onOpenReview={() => {
            setReviewTicket(openTicket);
            setOpenTicket(null);
            setView('review');
          }}
        />
      )}
    </div>
  );
}
