/** Small building blocks shared by the screens. */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/50',
  secondary: 'border border-line bg-surface text-ink hover:bg-raised disabled:text-muted',
  ghost: 'text-muted hover:bg-raised hover:text-ink',
  danger: 'bg-danger text-white hover:brightness-95 disabled:opacity-50',
};

export function Button({
  variant = 'secondary',
  busy = false,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
      disabled={busy || props.disabled}
      {...props}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-r-transparent ${className}`} aria-hidden />;
}

export function Card({ children, className = '', ...props }: { children: ReactNode; className?: string; 'data-testid'?: string }) {
  return (
    <section className={`rounded-card border border-line bg-surface p-5 shadow-sm ${className}`} {...props}>
      {children}
    </section>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-xs font-semibold tracking-wider text-muted uppercase">{children}</h2>;
}

const TONES = {
  neutral: 'bg-raised text-muted',
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/20 text-amber-700 dark:text-warn',
  danger: 'bg-danger/15 text-danger',
  brand: 'bg-brand-500/15 text-brand-700 dark:text-brand-400',
};

export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

export function StatusIcon({ status }: { status: 'ok' | 'missing' | 'pending' | 'warning' }) {
  const styles = {
    ok: 'bg-ok text-white',
    missing: 'bg-danger text-white',
    pending: 'bg-warn text-white',
    warning: 'bg-warn text-white',
  };
  const symbols = { ok: '✓', missing: '✕', pending: '…', warning: '!' };
  return (
    <span className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${styles[status]}`} aria-hidden>
      {symbols[status]}
    </span>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; badge?: ReactNode }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-line" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          data-testid={`tab-${tab.id}`}
          onClick={() => onChange(tab.id)}
          className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium ${
            tab.id === active ? 'border-brand-500 text-ink' : 'border-transparent text-muted hover:text-ink'
          }`}
        >
          {tab.label}
          {tab.badge}
        </button>
      ))}
    </div>
  );
}

export function LogView({ lines }: { lines: string[] }) {
  return (
    <pre className="max-h-56 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-200" data-testid="log-view">
      {lines.slice(-200).join('\n') || '…'}
    </pre>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/50 p-6" role="dialog" aria-modal aria-label={title}>
      <div className="w-full max-w-lg rounded-card border border-line bg-surface p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="text-muted hover:text-ink" aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
