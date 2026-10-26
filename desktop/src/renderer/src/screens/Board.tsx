import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Snapshot } from '@shared/api.ts';
import { PLAYER_MOVES, isPlayerMoveAllowed } from '@shared/kanban.ts';
import { COLUMNS } from '@shared/types.ts';
import type { Column, TicketState } from '@shared/types.ts';
import { api } from '../api.ts';
import { Badge, Spinner } from '../components/ui.tsx';
import { useToast } from '../toast-context.ts';

const DRAG_TYPE = 'application/x-bugdetective-ticket';

const ACCENT: Record<Column, string> = {
  todo: 'bg-col-todo',
  inProgress: 'bg-col-progress',
  inQa: 'bg-col-qa',
  codeReview: 'bg-col-review',
  done: 'bg-col-done',
};

function TicketCard({
  ticket,
  title,
  draggable,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  ticket: TicketState;
  title: string;
  draggable: boolean;
  onOpen: () => void;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const { t } = useTranslation();
  const [key, ...rest] = title.split(': ');
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      data-testid={`card-${ticket.ticket}`}
      data-status={ticket.status}
      className={`w-full rounded-lg border border-line bg-surface p-3 text-left shadow-sm transition hover:border-brand-400 hover:shadow ${
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
      }`}
    >
      <p className="font-mono text-xs text-muted">{rest.length > 0 ? key : `#${ticket.ticket}`}</p>
      <p className="mt-1 text-sm font-medium">{rest.length > 0 ? rest.join(': ') : title}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {ticket.status === 'inQa' && (
          <Badge tone="warn">
            <Spinner className="size-3" /> {t('board.qaRunning')}
          </Badge>
        )}
        {ticket.attempts.length > 0 && <Badge>{t('board.attempts', { count: ticket.attempts.length })}</Badge>}
      </div>
    </div>
  );
}

export function Board({ snapshot, onOpenTicket }: { snapshot: Snapshot; onOpenTicket: (ticket: number) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { state } = snapshot;
  const language = state.settings.language;
  // The ref is set synchronously on dragstart: dragover can fire before React re-renders.
  const draggingRef = useRef<TicketState | null>(null);
  const [dragging, setDragging] = useState<TicketState | null>(null);
  const [over, setOver] = useState<Column | null>(null);

  const canDrag = (ticket: TicketState) =>
    ticket.ticket === state.currentTicket && (PLAYER_MOVES[ticket.status]?.length ?? 0) > 0 && snapshot.busy !== 'qa';

  const endDrag = () => {
    draggingRef.current = null;
    setDragging(null);
    setOver(null);
  };

  const drop = async (column: Column, ticketNumber: number) => {
    const ticket = draggingRef.current ?? state.tickets.find((item) => item.ticket === ticketNumber) ?? null;
    endDrag();
    if (!ticket || ticket.status === column) {
      return;
    }
    if (!isPlayerMoveAllowed(ticket.status, column)) {
      toast.info(t('board.notAllowed'));
      return;
    }
    try {
      await api.move(ticket.ticket, column);
    } catch (error) {
      toast.error(error);
    }
  };

  return (
    <div className="flex h-full flex-col p-8" data-testid="board">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold">{t('board.title')}</h1>
        <p className="mt-1 text-sm text-muted">{state.tickets.length === 0 ? t('board.empty') : t('board.hint')}</p>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-5 gap-4">
        {COLUMNS.map((column) => {
          const tickets = state.tickets.filter((ticket) => ticket.status === column);
          const allowed = dragging ? isPlayerMoveAllowed(dragging.status, column) : false;
          const isTicketDrag = (event: DragEvent) => event.dataTransfer.types.includes(DRAG_TYPE);
          return (
            <section
              key={column}
              data-testid={`column-${column}`}
              onDragOver={(event) => {
                if (isTicketDrag(event)) {
                  // Every column accepts the drop, so a forbidden one can explain why it refuses.
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setOver(column);
                }
              }}
              onDragLeave={() => setOver((current) => (current === column ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                void drop(column, Number(event.dataTransfer.getData(DRAG_TYPE)));
              }}
              className={`flex min-h-0 flex-col rounded-card border bg-raised/60 transition ${
                dragging && allowed ? 'border-brand-400 ring-2 ring-brand-400/40' : 'border-line'
              } ${dragging && !allowed ? 'opacity-60' : ''} ${over === column && allowed ? 'bg-brand-500/10' : ''}`}
            >
              <div className={`h-1 rounded-t-card ${ACCENT[column]}`} />
              <h2 className="flex items-center justify-between px-3 py-2.5 text-sm font-semibold">
                {t(`board.columns.${column}`)}
                <span className="text-xs font-normal text-muted">{tickets.length}</span>
              </h2>
              <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-3">
                {tickets.map((ticket) => (
                  <TicketCard
                    key={ticket.ticket}
                    ticket={ticket}
                    title={snapshot.titles[ticket.ticket]?.[language] ?? `Ticket ${ticket.ticket}`}
                    draggable={canDrag(ticket)}
                    onOpen={() => onOpenTicket(ticket.ticket)}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(DRAG_TYPE, String(ticket.ticket));
                      event.dataTransfer.effectAllowed = 'move';
                      draggingRef.current = ticket;
                      setDragging(ticket);
                    }}
                    onDragEnd={endDrag}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
